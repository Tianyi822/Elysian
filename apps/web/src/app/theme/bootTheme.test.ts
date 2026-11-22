import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const boot = readFileSync(new NodeURL('../../../index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]!
describe('首屏主题脚本', () => {
  it.each([
    { pathname: '/login', stored: null, theme: 'dark' },
    { pathname: '/login/', stored: 'light', theme: 'light' },
    { pathname: '/settings', stored: null, theme: 'light' },
  ])('系统为浅色时，$pathname 有偏好 $stored 使用 $theme', ({ pathname, stored, theme }) => {
    const dataset: Record<string, string> = {}
    runInNewContext(boot, {
      document: { location: { pathname }, documentElement: { dataset } },
      matchMedia: () => ({ matches: true }),
      localStorage: { getItem: () => stored && JSON.stringify({ version: 1, theme: stored }) },
    })
    expect(dataset.theme).toBe(theme)
  })

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
