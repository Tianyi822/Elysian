import { AGENT_ATTACHMENT_LIMITS } from '@elysian/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAgentImage } from './agentImagePreparation'

type Encoding = { width: number; height: number; type: string; quality: number | undefined }
const limit = AGENT_ATTACHMENT_LIMITS.maxFileBytes
let width: number
let height: number
let close: ReturnType<typeof vi.fn>
let drawImage: ReturnType<typeof vi.fn>
let getImageData: ReturnType<typeof vi.fn>
let encodings: Encoding[]
let encodedSize: (encoding: Encoding) => number
let canvases: HTMLCanvasElement[]

function imageFile(type = 'image/jpeg', size = limit + 1, name = 'picture.jpg'): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 123 })
}

beforeEach(() => {
  width = 1200
  height = 800
  close = vi.fn()
  drawImage = vi.fn()
  getImageData = vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }))
  encodings = []
  canvases = []
  encodedSize = () => limit - 10
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close })))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    canvases.push(this)
    return { drawImage, getImageData, clearRect: vi.fn() } as unknown as CanvasRenderingContext2D
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type = 'image/png', quality) {
    const encoding = { width: this.width, height: this.height, type, quality: typeof quality === 'number' ? quality : undefined }
    encodings.push(encoding)
    callback(new Blob([new Uint8Array(encodedSize(encoding))], { type }))
  })
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Agent 图片预处理', () => {
  it.each([['photo.JPG', 'image/jpeg'], ['screen.png', 'image/png']])('无 MIME 的图片 %s 补齐类型后仍调用解码器', async (name, mime) => {
    const file = new File(['bytes'], name, { lastModified: 321 })
    const prepared = await prepareAgentImage(file)
    expect(prepared.type).toBe(mime)
    expect(prepared.name).toBe(name)
    expect(prepared.size).toBe(file.size)
    expect(prepared.lastModified).toBe(321)
    expect(createImageBitmap).toHaveBeenCalledWith(prepared, { imageOrientation: 'from-image' })
  })
  it.each([1, limit])('未超过字节和尺寸上限时保留同一文件及原始字节（%s 字节）', async size => {
    const file = imageFile('image/jpeg', size)
    expect(await prepareAgentImage(file)).toBe(file)
    expect(createImageBitmap).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' })
    expect(encodings).toHaveLength(0)
    expect(close).toHaveBeenCalledOnce()
  })

  it('小文件的超长边仍等比例缩至 6000，不放大另一条边', async () => {
    width = 12000
    height = 8000
    const result = await prepareAgentImage(imageFile('image/jpeg', 10))
    expect(result.size).toBeLessThanOrEqual(limit)
    expect(encodings).toEqual([{ width: 6000, height: 4000, type: 'image/jpeg', quality: 0.95 }])
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 6000, 4000)
    expect(canvases[0]?.width).toBe(0)
    expect(canvases[0]?.height).toBe(0)
  })

  it('JPEG 在原尺寸内寻找能满足限制的最高质量', async () => {
    const threshold = 0.9
    encodedSize = encoding => encoding.quality! > threshold ? limit + 1 : limit - 1
    const result = await prepareAgentImage(imageFile())
    expect(result.size).toBe(limit - 1)
    expect(result.type).toBe('image/jpeg')
    expect(result.lastModified).toBe(123)
    expect(encodings.every(encoding => encoding.width === 1200 && encoding.height === 800)).toBe(true)
    const passing = encodings.filter(encoding => encoding.quality! <= threshold)
    expect(Math.max(...passing.map(encoding => encoding.quality!))).toBeCloseTo(threshold, 2)
    expect(encodings).toHaveLength(10)
  })

  it('最低 JPEG 质量仍超限时按 85% 缩小，从原图重新绘制', async () => {
    encodedSize = encoding => encoding.width === 1200 ? limit + 1 : limit - 1
    const result = await prepareAgentImage(imageFile())
    expect(result.size).toBeLessThanOrEqual(limit)
    expect(encodings.map(({ width: w, height: h, quality }) => [w, h, quality])).toEqual([
      [1200, 800, 0.95], [1200, 800, 0.8], [1020, 680, 0.95],
    ])
    expect(drawImage.mock.calls[0]?.[0]).toBe(drawImage.mock.calls[1]?.[0])
  })

  it('PNG 优先无损重编码，能满足限制时无需检查透明通道', async () => {
    const result = await prepareAgentImage(imageFile('image/png', limit + 1, 'screen.png'))
    expect(result.name).toBe('screen.png')
    expect(result.type).toBe('image/png')
    expect(encodings).toHaveLength(1)
    expect(getImageData).not.toHaveBeenCalled()
  })

  it('不透明 PNG 可转成 JPEG，同时更新文件名、MIME 和实际大小', async () => {
    encodedSize = encoding => encoding.type === 'image/png' ? limit + 1 : limit - 10
    const result = await prepareAgentImage(imageFile('image/png', limit + 1, 'screen.PNG'))
    expect(result.name).toBe('screen.jpg')
    expect(result.type).toBe('image/jpeg')
    expect(result.size).toBe(limit - 10)
    expect(getImageData).toHaveBeenCalled()
    expect(encodings.map(encoding => encoding.type)).toEqual(['image/png', 'image/jpeg'])
    expect(canvases).toHaveLength(1)
    expect(drawImage).toHaveBeenCalledOnce()
  })

  it('透明 PNG 始终使用 PNG 并在超限时缩小，扫描结果只读取一次', async () => {
    getImageData.mockReturnValue({ data: new Uint8ClampedArray([0, 0, 0, 127]) })
    encodedSize = encoding => encoding.width === 1200 ? limit + 1 : limit - 10
    const result = await prepareAgentImage(imageFile('image/png', limit + 1, 'transparent.png'))
    expect(result.type).toBe('image/png')
    expect(result.name).toBe('transparent.png')
    expect(encodings.map(encoding => [encoding.type, encoding.width, encoding.height])).toEqual([
      ['image/png', 1200, 800], ['image/png', 1020, 680],
    ])
    expect(getImageData).toHaveBeenCalledOnce()
  })

  it('首次缩放抹去微小透明区时仍按原始像素检查，不转为 JPEG', async () => {
    width = 12000
    height = 8000
    getImageData.mockImplementation(() => {
      const draw = drawImage.mock.calls.at(-1)!
      const originalCorner = draw.length === 9 && draw[1] + draw[3] === width && draw[2] + draw[4] === height
      return { data: new Uint8ClampedArray([0, 0, 0, originalCorner ? 127 : 255]) }
    })
    encodedSize = encoding => encoding.type === 'image/png' && encoding.width === 6000 ? limit + 1 : limit - 10
    const result = await prepareAgentImage(imageFile('image/png', limit + 1, 'tiny-alpha.png'))
    expect(result.type).toBe('image/png')
    expect(encodings.map(encoding => [encoding.type, encoding.width, encoding.height])).toEqual([
      ['image/png', 6000, 4000], ['image/png', 5100, 3400],
    ])
    const originalTiles = drawImage.mock.calls.filter(draw => draw.length === 9)
    expect(originalTiles.length).toBeGreaterThan(1)
    expect(originalTiles.every(draw => draw[3] === draw[7] && draw[4] === draw[8] && draw[3] <= 512 && draw[4] <= 512)).toBe(true)
    expect(originalTiles.at(-1)?.slice(1)).toEqual([11776, 7680, 224, 320, 0, 0, 224, 320])
    expect(getImageData.mock.calls.every(call => call[2] <= 512 && call[3] <= 512)).toBe(true)
    expect(canvases).toHaveLength(2)
    expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('编码失败指出具体文件，并释放解码和 Canvas 资源', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(callback => callback(null))
    await expect(prepareAgentImage(imageFile('image/png', limit + 1, '失败.png'))).rejects.toThrow('“失败.png”处理失败：浏览器无法编码图片。')
    expect(close).toHaveBeenCalledOnce()
    expect(canvases[0]?.width).toBe(0)
    expect(canvases[0]?.height).toBe(0)
  })

  it('Canvas 不可用时保留具体文件名', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    await expect(prepareAgentImage(imageFile())).rejects.toThrow('“picture.jpg”处理失败：浏览器不支持图片压缩。')
    expect(close).toHaveBeenCalledOnce()
  })

  it('Image 解码回退保留方向处理，并释放临时 URL', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')))
    const revoke = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fallback'), revokeObjectURL: revoke })
    const remove = vi.fn()
    class FallbackImage {
      naturalWidth = 40
      naturalHeight = 80
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) { queueMicrotask(() => this.onload?.()) }
      removeAttribute = remove
    }
    vi.stubGlobal('Image', FallbackImage)
    const file = imageFile('image/jpeg', 10)
    expect(await prepareAgentImage(file)).toBe(file)
    expect(revoke).toHaveBeenCalledWith('blob:fallback')
    expect(remove).toHaveBeenCalledWith('src')
  })

  it('无法解码的文件报中文错误并释放回退 URL', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    const revoke = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:invalid'), revokeObjectURL: revoke })
    class InvalidImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) { queueMicrotask(() => this.onerror?.()) }
      removeAttribute() {}
    }
    vi.stubGlobal('Image', InvalidImage)
    await expect(prepareAgentImage(imageFile('image/jpeg', 10, '损坏.jpg'))).rejects.toThrow('“损坏.jpg”处理失败：无法解码图片。')
    expect(revoke).toHaveBeenCalledWith('blob:invalid')
  })

  it('解码期间取消立即拒绝，并释放稍后到达的 bitmap', async () => {
    let finishDecode: ((bitmap: object) => void) | undefined
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => { finishDecode = resolve })))
    const controller = new AbortController()
    const result = prepareAgentImage(imageFile(), controller.signal)
    await Promise.resolve()
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    finishDecode?.({ width, height, close })
    await Promise.resolve()
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
    expect(encodings).toHaveLength(0)
  })

  it('编码期间取消立即释放资源，迟到的编码结果不会成功返回', async () => {
    let callback: BlobCallback | undefined
    let started: (() => void) | undefined
    const encodingStarted = new Promise<void>(resolve => { started = resolve })
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(value => { callback = value; started?.() })
    const controller = new AbortController()
    const result = prepareAgentImage(imageFile(), controller.signal)
    await encodingStarted
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(close).toHaveBeenCalledOnce()
    expect(canvases[0]?.width).toBe(0)
    callback?.(new Blob(['late'], { type: 'image/jpeg' }))
  })

  it('已取消及不支持的格式在解码前拒绝', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(prepareAgentImage(imageFile(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(prepareAgentImage(imageFile('image/webp', 1, 'image.webp'))).rejects.toThrow('“image.webp”仅支持 JPEG 或 PNG 图片。')
    expect(createImageBitmap).not.toHaveBeenCalled()
  })
})
