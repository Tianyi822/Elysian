import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandTerminal, commandTerminalText } from './CommandTerminal'

const library = vi.hoisted(() => ({
  interpreter: undefined as ((command: string) => Promise<void>) | undefined,
  options: undefined as JQueryTerminal.TerminalOptions | undefined,
  instance: { echo: vi.fn(), clear: vi.fn(), set_prompt: vi.fn(), set_command: vi.fn(), focus: vi.fn(), enable: vi.fn(), disable: vi.fn(), resize: vi.fn(), destroy: vi.fn() },
}))
vi.mock('./commandTerminalLibrary', () => ({
  loadCommandTerminalLibrary: async () => Object.assign((node: HTMLElement) => ({ terminal: (interpreter: (command: string) => Promise<void>, options: JQueryTerminal.TerminalOptions) => {
    library.interpreter = interpreter
    library.options = options
    node.append(document.createElement('textarea'))
    return library.instance
  } }), { terminal: { escape_brackets: (value: string) => value.replaceAll('[', '&#91;').replaceAll(']', '&#93;') } }),
}))
beforeEach(() => {
  vi.clearAllMocks()
  library.instance.enable.mockReturnValue(library.instance)
  library.interpreter = undefined
  library.options = undefined
})
async function loaded() { await waitFor(() => expect(library.interpreter).toBeDefined()) }

describe('第三方命令终端接缝', () => {
  it('每会话只用内存历史，关闭动态执行并通过库完成补全', async () => {
    render(<CommandTerminal sessionKey="database-1" prompt="db> " execute={async () => []} completions={['SHOW TABLES', 'SELECT']} inputLabel="SQL 输入" />)
    await loaded()
    expect(library.options).toMatchObject({ memory: true, name: 'database-1', historySize: 100, invokeMethods: false, execHash: false, historyState: false, convertLinks: false, wordAutocomplete: false })
    expect(screen.getByLabelText('SQL 输入')).toHaveAttribute('spellcheck', 'false')
    const callback = vi.fn()
    const completion = library.options?.completion as (input: string, callback: (matches: string[]) => void) => void
    completion('SH', callback)
    expect(callback).toHaveBeenCalledWith(['SHOW TABLES', 'SELECT'])
  })

  it('语句原文只交给 execute，输出里的控制字符和扩展命令按文本显示', async () => {
    const execute = vi.fn(async () => ['\x1b[2J[[clear]] <script>bad</script>'])
    render(<CommandTerminal sessionKey="db-1" prompt="db> " execute={execute} />)
    await loaded()
    await act(() => library.interpreter!(' SELECT * FROM users; '))
    expect(execute).toHaveBeenCalledExactlyOnceWith(' SELECT * FROM users; ')
    expect(library.instance.echo).toHaveBeenCalledWith('\\x1b&#91;2J&#91;&#91;clear&#93;&#93; <script>bad</script>', expect.objectContaining({ raw: false, formatters: false, exec: false, invokeMethods: false, ansi: false }))
    expect(commandTerminalText('\r\u009d')).toBe('\\x0d\\x9d')
  })

  it('中断等待并忽略旧执行结果，库负责编辑与历史', async () => {
    let resolve!: (lines: string[]) => void
    const onInterrupt = vi.fn()
    render(<CommandTerminal sessionKey="db-1" prompt="db> " execute={() => new Promise<string[]>((done) => { resolve = done })} onInterrupt={onInterrupt} />)
    await loaded()
    const pending = library.interpreter!('slow')
    const interrupt = library.options?.keymap?.['CTRL+C'] as () => void
    await act(async () => { interrupt(); await pending })
    expect(onInterrupt).toHaveBeenCalledOnce()
    resolve(['late secret'])
    await act(async () => { await Promise.resolve() })
    expect(library.instance.echo).not.toHaveBeenCalledWith('late secret', expect.anything())
  })

  it('组合输入的确认回车不传给库，普通回车仍可到达', async () => {
    render(<CommandTerminal sessionKey="db-1" prompt="db> " execute={async () => []} inputLabel="SQL 输入" />)
    await loaded()
    const input = screen.getByLabelText('SQL 输入')
    const listener = vi.fn()
    input.addEventListener('keydown', listener)
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(listener).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    await new Promise((resolve) => setTimeout(resolve, 1))
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('卸载会话中断待决操作并释放库实例', async () => {
    const view = render(<CommandTerminal sessionKey="db-1" prompt="db> " execute={() => new Promise(() => {})} />)
    await loaded()
    const pending = library.interpreter!('slow')
    view.unmount()
    await pending
    expect(library.instance.destroy).toHaveBeenCalledOnce()
  })
})
