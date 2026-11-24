import { useMemo } from 'react'
import { Button } from './Button'
import { useClipboardCopy } from './CopyButton'
import { HighlightedCode } from './ChatCodeBlock'

export function quoteContainerArgument(token: string): string {
  return /^[a-zA-Z0-9_@%+=:,./-]+$/.test(token) ? token : "'" + token.replaceAll("'", "'\\''") + "'"
}

export function ContainerStartupCommand({ argv, fallback }: { argv?: readonly string[]; fallback: string }) {
  const { copied, copy, error } = useClipboardCopy()
  const command = argv?.length ? argv.map(quoteContainerArgument).join(' ') : fallback
  const display = useMemo(() => {
    if (!argv?.length) return []
    const shell = /(^|\/)(sh|bash|dash|ash|zsh)$/.test(argv[0] ?? '')
    const scriptFlag = shell ? argv.findIndex((argument, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(argument)) : -1
    return argv.map((argument, i) => ({ argument, script: scriptFlag > 0 && scriptFlag + 1 === i }))
  }, [argv])
  if (!command) return <p>沿用镜像默认入口</p>
  return <div className="min-w-0 space-y-2">
    <Button variant="outline" type="button" onClick={() => void copy(command, '启动命令')}>{copied ? '已复制' : '复制命令'}</Button>
    <div role="status" className="sr-only">{copied ? '已复制启动命令' : ''}</div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <div className="chat-code-block min-w-0 space-y-2 rounded-lg bg-code-bg px-3 py-2">
      {display.length ? display.map(({ argument, script }, i) => <div key={i} className="min-w-0">
        <div className="text-xs text-fg-muted">{i === 0 ? '程序' : script ? 'Shell 脚本' : `参数 ${i}`}</div>
        <pre className="!whitespace-pre-wrap !p-0 [overflow-wrap:anywhere]"><code><HighlightedCode value={script ? argument : quoteContainerArgument(argument)} language="bash" /></code></pre>
      </div>) : <pre className="!whitespace-pre-wrap !p-0 [overflow-wrap:anywhere]"><code><HighlightedCode value={command} language="bash" /></code></pre>}
    </div>
  </div>
}
