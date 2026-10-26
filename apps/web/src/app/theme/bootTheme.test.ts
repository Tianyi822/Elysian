import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const boot = readFileSync(new NodeURL('../../../index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]!
describe('首屏主题脚本', () => {
  it.each(['missing', 'blocked'])('系统偏好 %s 且存储禁止时仍完成启动', failure => {
    const dataset: Record<string, string> = {}
    const context = {
      document: { documentElement: { dataset } },
      matchMedia: failure === 'missing' ? undefined : () => { throw new Error('blocked') },
      get localStorage() { throw new DOMException('blocked', 'SecurityError') },
    }
    expect(() => runInNewContext(boot, context)).not.toThrow()
    expect(dataset.theme).toBe('dark')
  })
})
