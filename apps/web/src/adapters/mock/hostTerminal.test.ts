import { describe, expect, it } from 'vitest'
import {
  completeHostTerminalCommand,
  execHostCommand,
  HOST_LABEL,
  HOST_USER,
} from './hostTerminal'

describe('本机演示终端命令引擎', () => {
  it('help 列出全部可用命令', () => {
    const { lines } = execHostCommand('help')
    expect(lines.join(' ')).toContain('whoami')
    expect(lines.join(' ')).toContain('hostname')
    expect(lines.join(' ')).toContain('df -h')
  })

  it('whoami、hostname、pwd、id 给出本机身份', () => {
    expect(execHostCommand('whoami').lines).toEqual([HOST_USER])
    expect(execHostCommand('hostname').lines).toEqual([HOST_LABEL])
    expect(execHostCommand('pwd').lines).toEqual([`/home/${HOST_USER}`])
    expect(execHostCommand('id').lines[0]).toContain(`(${HOST_USER})`)
  })

  it('ls 列出家目录条目，按终端习惯横排分栏', () => {
    expect(execHostCommand('ls').lines).toEqual(['.ssh  Documents  Downloads'])
  })

  it('uname -a、df -h、uptime 给出确定性主机快照', () => {
    expect(execHostCommand('uname -a').lines[0]).toContain(HOST_LABEL)
    expect(execHostCommand('df -h').lines[0]).toContain('Filesystem')
    expect(execHostCommand('uptime').lines[0]).toMatch(/^up /)
  })

  it('clear 置清屏标记；未知命令给出中文提示', () => {
    const cleared = execHostCommand('clear')
    expect(cleared.clear).toBe(true)
    expect(cleared.lines).toEqual([])
    const unknown = execHostCommand('rm -rf /')
    expect(unknown.lines[0]).toContain('演示终端')
    expect(unknown.lines[0]).toContain('help')
  })

  it('命令两侧空白不影响识别', () => {
    expect(execHostCommand('  whoami ').lines).toEqual([HOST_USER])
  })
})

describe('本机终端 Tab 补全', () => {
  it('唯一前缀补全为完整命令并补一个空格', () => {
    expect(completeHostTerminalCommand('who', 3)).toEqual({ draft: 'whoami ', cursor: 7 })
  })

  it('df 补 -h 参数', () => {
    expect(completeHostTerminalCommand('df ', 3)).toEqual({ draft: 'df -h ', cursor: 6 })
  })

  it('uname 补 -a 参数', () => {
    expect(completeHostTerminalCommand('uname ', 6)).toEqual({ draft: 'uname -a ', cursor: 9 })
  })

  it('没有匹配时原样返回', () => {
    expect(completeHostTerminalCommand('zz', 2)).toEqual({ draft: 'zz', cursor: 2 })
  })
})
