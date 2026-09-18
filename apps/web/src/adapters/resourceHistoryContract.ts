import { describe, expect, it } from 'vitest'
import type { ResourceHistoryAdapter } from '../contracts/adapters'

/** ResourceHistoryAdapter 可复用断言；mock 与未来真实实现共用。 */
export function runResourceHistoryContract(adapter: ResourceHistoryAdapter): void {
  describe('ResourceHistoryAdapter 契约', () => {
    it('list(5m) 返回升序时序点', async () => {
      const points = await adapter.list('5m')
      expect(Array.isArray(points)).toBe(true)
      for (let i = 1; i < points.length; i += 1) {
        expect(points[i]!.ts).toBeGreaterThanOrEqual(points[i - 1]!.ts)
      }
      if (points[0]) {
        expect(points[0]).toEqual(
          expect.objectContaining({
            ts: expect.any(Number),
            cpu: expect.any(Number),
            memory: expect.any(Number),
            networkIo: expect.any(Number),
            diskIo: expect.any(Number),
          }),
        )
      }
    })
  })
}
