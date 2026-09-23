import { describe, expect, it } from 'vitest'
import { CONTAINERS, CONTAINER_IMAGES } from './containersData'
import { completeTerminalCommand, execContainerCommand } from './containerTerminal'

const nginx = CONTAINERS.find((c) => c.id === 'ctr-nginx-proxy')!
const nginxImage = CONTAINER_IMAGES.find((i) => i.id === 'img-nginx')!

describe('演示终端命令引擎', () => {
  it('help 列出全部可用命令', () => {
    const { lines } = execContainerCommand(nginx, nginxImage, 'help')
    expect(lines.join(' ')).toContain('ls')
    expect(lines.join(' ')).toContain('df -h')
  })

  it('ls 列挂载卷目标路径，env 列环境变量，输出与该容器数据联动', () => {
    expect(execContainerCommand(nginx, nginxImage, 'ls').lines).toEqual(['/etc/nginx/conf.d'])
    expect(execContainerCommand(nginx, nginxImage, 'env').lines).toEqual(['TZ=Asia/Shanghai'])

    const worker = CONTAINERS.find((c) => c.id === 'ctr-elysian-worker')!
    expect(execContainerCommand(worker, nginxImage, 'ls').lines[0]).toContain('空')
  })

  it('ps 表头与数据列右对齐到同一列', () => {
    const [header, row] = execContainerCommand(nginx, nginxImage, 'ps').lines
    expect(header).toBe('    PID CMD')
    expect(row).toBe(`      1 ${nginx.command}`)
    expect(header!.indexOf('CMD')).toBe(row!.indexOf(nginx.command))
  })

  it('cat /etc/os-release 反映镜像名称与标签', () => {
    const lines = execContainerCommand(nginx, nginxImage, 'cat /etc/os-release').lines.join('\n')
    expect(lines).toContain('NAME="nginx"')
    expect(lines).toContain('VERSION="1.27-alpine"')
  })

  it('uptime 与 top 输出运行时长和资源快照', () => {
    expect(execContainerCommand(nginx, nginxImage, 'uptime').lines[0]).toMatch(/^up /)
    const top = execContainerCommand(nginx, nginxImage, 'top').lines.join(' ')
    expect(top).toContain('CPU')
    expect(top).toContain('内存')
  })

  it('clear 置清屏标记；未知命令给出中文提示', () => {
    const cleared = execContainerCommand(nginx, nginxImage, 'clear')
    expect(cleared.clear).toBe(true)
    expect(cleared.lines).toEqual([])
    const unknown = execContainerCommand(nginx, nginxImage, 'rm -rf /')
    expect(unknown.lines[0]).toContain('演示终端')
    expect(unknown.lines[0]).toContain('help')
  })

  it('命令两侧空白不影响识别', () => {
    expect(execContainerCommand(nginx, nginxImage, '  help ').lines.length).toBeGreaterThan(0)
  })
})

describe('终端 Tab 补全', () => {
  it('唯一前缀补全为完整命令并补一个空格', () => {
    expect(completeTerminalCommand('hel', 3)).toEqual({ draft: 'help ', cursor: 5 })
  })

  it('cat 与 df 补各自的参数候选', () => {
    expect(completeTerminalCommand('cat ', 4)).toEqual({
      draft: 'cat /etc/os-release ',
      cursor: 20,
    })
    expect(completeTerminalCommand('df -', 4)).toEqual({ draft: 'df -h ', cursor: 6 })
  })

  it('多候选且无公共前缀可收敛时回传候选列表，草稿不动', () => {
    const result = completeTerminalCommand('c', 1)
    expect(result.draft).toBe('c')
    expect(result.cursor).toBe(1)
    expect(result.candidates).toEqual(['cat', 'clear'])
  })

  it('光标不在词尾时只补光标前的词，词后原有空白保留', () => {
    expect(completeTerminalCommand('hel x', 3)).toEqual({ draft: 'help  x', cursor: 5 })
  })

  it('没有匹配时原样返回', () => {
    expect(completeTerminalCommand('zz', 2)).toEqual({ draft: 'zz', cursor: 2 })
  })
})
