import { describe, expect, it } from 'vitest'
import { agentComposerFileKind, appendAgentTextFiles, readAgentTextFiles } from './agentTextFiles'

describe('聊天文本文件', () => {
  it.each(['photo.JPG', 'photo.jpeg', 'screen.png'])('系统未声明 MIME 时仍识别图片 %s', name => {
    expect(agentComposerFileKind(new File(['bytes'], name))).toBe('image')
    expect(agentComposerFileKind(new File(['bytes'], name, { type: 'application/octet-stream' }))).toBe('image')
    expect(agentComposerFileKind(new File(['bytes'], name, { type: 'application/pdf' }))).toBe('unsupported')
  })
  it.each(['notes.txt', 'README.md', 'server.log', 'settings.json', 'docker-compose.yml', 'events.csv', 'data.tsv', 'app.ts', 'main.go', 'script.py', '.env', 'Dockerfile'])('识别无 MIME 的常用文本文件 %s', name => {
    expect(agentComposerFileKind(new File(['正文'], name))).toBe('text')
  })
  it.each([['scan.pdf', 'application/pdf'], ['book.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['demo.gif', 'image/gif'], ['picture.webp', 'image/webp'], ['sound.mp3', 'audio/mpeg'], ['movie.mp4', 'video/mp4'], ['data.zip', 'application/zip'], ['fake.txt', 'application/pdf']])('拒绝不能送入模型的格式 %s', (name, type) => {
    expect(agentComposerFileKind(new File(['data'], name, { type }))).toBe('unsupported')
  })
  it('保留中文、emoji、换行、代码与 HTML 字面内容，多个文件有明确名称', async () => {
    const files = [new File(['你好 🌏\n\tconst x = "引号";\n<script>alert(1)</script>'], '代码.md', { type: 'text/markdown' }), new File(['a,b\r\n1,2'], 'data.csv')]
    const imported = await readAgentTextFiles(files)
    expect(imported).toBe('文件："代码.md"\n你好 🌏\n\tconst x = "引号";\n<script>alert(1)</script>\n\n文件："data.csv"\na,b\r\n1,2')
    expect(appendAgentTextFiles('原草稿', imported)).toBe(`原草稿\n\n${imported}`)
  })
  it('支持 UTF-8 BOM 与带 BOM 的 UTF-16，拒绝错误编码、空文件与二进制', async () => {
    expect(await readAgentTextFiles([new File([new Uint8Array([0xef, 0xbb, 0xbf, 0x41])], 'bom.txt')])).toContain('\nA')
    expect(await readAgentTextFiles([new File([new Uint8Array([0xff, 0xfe, 0x2d, 0x4e])], 'utf16.txt')])).toContain('\n中')
    expect(await readAgentTextFiles([new File([new Uint8Array([0xfe, 0xff, 0x4e, 0x2d])], 'utf16be.txt')])).toContain('\n中')
    await expect(readAgentTextFiles([new File([new Uint8Array([0xc3, 0x28])], 'invalid.txt')])).rejects.toThrow('转换编码')
    await expect(readAgentTextFiles([new File([''], 'empty.txt')])).rejects.toThrow('为空')
    await expect(readAgentTextFiles([new File(['a\0b'], 'binary.txt')])).rejects.toThrow('二进制')
  })
  it('读取前限制文件总量，导入后按 UTF-8 字节校验正文和文件名开销', async () => {
    await expect(readAgentTextFiles([new File(['x'.repeat(32769)], 'large.log')])).rejects.toThrow('合计不能超过 32 KiB')
    const imported = await readAgentTextFiles([new File(['中'.repeat(10000)], '大文本.txt')])
    expect(() => appendAgentTextFiles('草稿'.repeat(1000), imported)).toThrow('导入后的消息超过 32 KiB')
    expect(appendAgentTextFiles('', 'x'.repeat(32768))).toHaveLength(32768)
    expect(() => appendAgentTextFiles('', 'x'.repeat(32769))).toThrow('32 KiB')
  })
  it('取消读取不返回部分文本', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(readAgentTextFiles([new File(['内容'], 'abort.txt')], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
