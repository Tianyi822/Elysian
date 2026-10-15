import { describe, expect, it } from 'vitest'
import { codeLanguageLabel, highlightCode } from './codeHighlight'

describe('代码语言着色', () => {
  it.each([
    ['bash', 'if true; then echo "ready"; fi'],
    ['shell', '$ echo "ready"'],
    ['powershell', 'Write-Host "ready"'],
    ['dockerfile', 'FROM nginx:1.27'],
    ['nginx', 'server { listen 80; }'],
    ['ini', '[server]\nport = 48100'],
    ['toml', '[server]\nport = 48100'],
    ['yaml', 'services:\n  web: nginx'],
    ['json', '{"ready": true}'],
    ['xml', '<server port="48100" />'],
    ['html', '<div class="ready">Ready</div>'],
    ['css', '.ready { color: green; }'],
    ['javascript', 'const ready = true'],
    ['jsx', 'const view = <div className="ready">Ready</div>'],
    ['typescript', 'const port: number = 48100'],
    ['tsx', 'const view: ReactNode = <div>Ready</div>'],
    ['python', 'def ready():\n  return True'],
    ['go', 'package main\nfunc main() {}'],
    ['java', 'public class Main {}'],
    ['sql', 'SELECT name FROM services;'],
    ['c', 'int main() { return 0; }'],
    ['cpp', 'std::string ready = "yes";'],
    ['rust', 'fn main() { let ready = true; }'],
    ['markdown', '# Ready\n\n**yes**'],
    ['diff', '-old\n+new'],
    ['sh', 'if true; then echo "ready"; fi'],
    ['zsh', 'if true; then echo "ready"; fi'],
    ['js', 'const ready = true'],
    ['ts', 'const port: number = 48100'],
    ['yml', 'ready: true'],
  ])('支持 %s 并生成结构化文本与 token', (language, value) => {
    const tree = highlightCode(value, language)
    expect(tree?.type).toBe('root')
    expect(tree?.children.some(node => node.type === 'element')).toBe(true)
  })

  it('不猜测语言，未知语言与纯文本不着色', () => {
    for (const language of ['', 'unknown', 'plaintext', 'text', '__proto__']) {
      expect(highlightCode('const ready = true', language)).toBeNull()
    }
    expect(codeLanguageLabel('')).toBe('纯文本')
    expect(codeLanguageLabel('unknown')).toBe('unknown')
    expect(codeLanguageLabel('__proto__')).toBe('__proto__')
  })

  it('超过 64 KiB 时返回纯文本，限制按 UTF-8 字节而非字符数计算', () => {
    expect(highlightCode('a'.repeat(64 * 1024), 'javascript')).not.toBeNull()
    expect(highlightCode('a'.repeat(64 * 1024 + 1), 'javascript')).toBeNull()
    expect(highlightCode('字'.repeat(22_000), 'javascript')).toBeNull()
  })

  it('流式不完整语句仍安全产生 token', () => {
    expect(highlightCode('const view = <div className="', 'jsx')).not.toBeNull()
    expect(highlightCode('{"ready":', 'json')).not.toBeNull()
  })
})
