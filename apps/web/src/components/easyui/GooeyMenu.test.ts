import { describe, expect, it } from 'vitest'
import { GOOEY_SPRINGS } from './GooeyMenu'

/** 阻尼比低于 1 的弹簧会冲过目标再折返：0.55 约过冲 13%，0.8 约过冲 1.5%。 */
function dampingRatio(spring: { stiffness: number; damping: number; mass?: number }) {
  return spring.damping / (2 * Math.sqrt(spring.stiffness * (spring.mass ?? 1)))
}

describe('Gooey 菜单的弹出动作', () => {
  it('位置、尺寸与选项的弹簧阻尼比都不低于 0.8，面板滑到位即停，不冲过头再折返', () => {
    for (const [name, spring] of Object.entries(GOOEY_SPRINGS)) {
      expect(dampingRatio(spring), name).toBeGreaterThanOrEqual(0.8)
    }
  })
})
