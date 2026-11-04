import { describe, expect, it } from 'vitest'
import type { ContainerAdapter } from '../contracts/adapters'

export function runRegistryPresetsContract(make: () => ContainerAdapter) {
  describe('镜像源目录契约', () => {
    it('返回有序且唯一的预设及 HTTPS 地址，不含自定义哨兵', async () => {
      const presets = await make().listRegistryPresets()
      expect(presets.map((item) => item.id)).toEqual(['official', 'dockerproxy', '1panel', '1ms'])
      expect(new Set(presets.map((item) => item.url)).size).toBe(presets.length)
      expect(presets.every((item) => item.label && /^https:\/\//.test(item.url))).toBe(true)
    })
  })
}
