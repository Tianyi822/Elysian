import { describe, expect, it } from 'vitest'
import type { SessionAdapter, SessionMode } from '../contracts/adapters'

/**
 * 会话 adapter 的可复用契约断言（照 containerAdapterContract 先例）：只依赖
 * SessionAdapter 接口本身，对 mock 与 http 两个实现跑同一套——这就是「mock 可替换」的验证方式。
 * 期望的 mode 由实现方声明（mock 为 demo、http 为 real）。
 */
export function runSessionAdapterContract(make: () => SessionAdapter, expectedMode: SessionMode): void {
  describe('SessionAdapter 契约', () => {
    it('status 返回 mode/authenticated/devAccount 三字段且形状合法', async () => {
      const status = await make().status()
      expect(status.mode).toBe(expectedMode)
      expect(typeof status.authenticated).toBe('boolean')
      expect(typeof status.devAccount).toBe('boolean')
    })

    it('canView 回布尔值（页面级权限占位的同一形状）', async () => {
      expect(typeof (await make().canView('dashboard'))).toBe('boolean')
    })

    it('login 成功路径不抛', async () => {
      await expect(make().login('admin', 'whatever')).resolves.toBeUndefined()
    })

    it('logout 幂等成功路径不抛', async () => {
      await expect(make().logout()).resolves.toBeUndefined()
    })
  })
}
