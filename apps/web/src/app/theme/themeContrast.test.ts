import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync('src/styles/index.css', 'utf8')

type Rgb = readonly [number, number, number]

function rgb(hex: string): Rgb {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as unknown as Rgb
}

function luminance(color: Rgb): number {
  const linear = color.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

function ratio(a: Rgb, b: Rgb): number {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y)
  return (hi! + 0.05) / (lo! + 0.05)
}

function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((channel, i) => channel * alpha + bg[i]! * (1 - alpha)) as unknown as Rgb
}

for (const theme of ['dark', 'light'] as const) {
  describe(`${theme === 'dark' ? '深色' : '浅色'}主题对比度`, () => {
    const block = css.split(`[data-theme="${theme}"] {`)[1]!.split('}')[0]!
    const tokens = Object.fromEntries([...block.matchAll(/--t-([\w-]+):\s*(#[\da-f]{6});/g)].map((match) => [match[1]!, rgb(match[2]!)]))
    const color = (key: string) => tokens[key]!

    it('正文、辅助文字、占位和状态文字在所有实底表面满足 4.5:1', () => {
      for (const bg of ['bg', 'surface', 'surface-raised']) {
        for (const fg of ['fg', 'fg-muted', 'fg-subtle', 'accent-fg', 'success', 'warning', 'danger', 'info']) {
          expect(ratio(color(fg), color(bg)), `${fg} / ${bg}`).toBeGreaterThanOrEqual(4.5)
        }
        for (const state of ['success', 'warning', 'danger', 'info', 'accent']) {
          expect(ratio(color(state === 'accent' ? 'accent-fg' : state), blend(color(state), color(bg), 0.1)), `${state} 标签 / ${bg}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    })

    it('严重等级与风险等级保持独立四档并满足文本对比度', () => {
      for (const family of ['sev1', 'sev2', 'sev3', 'sev4', 'risk-low', 'risk-medium', 'risk-high', 'risk-critical']) {
        expect(ratio(color(`${family}-fg`), color(family)), family).toBeGreaterThanOrEqual(4.5)
      }
    })

    it('必要控件边框、焦点和两条图表系列达到 3:1', () => {
      for (const bg of ['bg', 'surface', 'surface-raised']) {
        for (const fg of ['control-line', 'focus', 'accent', 'chart-secondary']) {
          expect(ratio(color(fg), color(bg)), `${fg} / ${bg}`).toBeGreaterThanOrEqual(3)
        }
      }
    })

    it('透明卡片在画布及嵌套表面上保持文字与必要控件对比度', () => {
      const glass = block.match(/--t-panel-glass: rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)/)!
      const tint: Rgb = [Number(glass[1]), Number(glass[2]), Number(glass[3])]
      for (const bg of ['bg', 'surface', 'surface-raised']) {
        const composite = blend(tint, color(bg), Number(glass[4]) / 100)
        for (const fg of ['fg', 'fg-muted', 'fg-subtle', 'accent-fg', 'success', 'warning', 'danger', 'info']) {
          expect(ratio(color(fg), composite), `${fg} / 透明卡片 / ${bg}`).toBeGreaterThanOrEqual(4.5)
        }
        for (const fg of ['control-line', 'focus', 'accent', 'chart-secondary']) {
          expect(ratio(color(fg), composite), `${fg} / 透明卡片 / ${bg}`).toBeGreaterThanOrEqual(3)
        }
      }
    })

    it('透明弹窗在两档遮罩上保持文字和控件的对比度', () => {
      const glass = block.match(/--t-panel-glass-overlay: rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)/)!
      const tint: Rgb = [Number(glass[1]), Number(glass[2]), Number(glass[3])]
      for (const overlay of ['overlay', 'overlay-strong']) {
        const value = block.match(new RegExp(`--t-${overlay}: rgb\\((\\d+) (\\d+) (\\d+) / (\\d+)%\\)`))!
        const shade: Rgb = [Number(value[1]), Number(value[2]), Number(value[3])]
        const backdrop = blend(shade, color('bg'), Number(value[4]) / 100)
        const composite = blend(tint, backdrop, Number(glass[4]) / 100)
        for (const fg of ['fg', 'fg-muted', 'fg-subtle', 'danger', 'warning']) {
          expect(ratio(color(fg), composite), `${fg} / 弹窗 / ${overlay}`).toBeGreaterThanOrEqual(4.5)
        }
        for (const fg of ['control-line', 'focus']) {
          expect(ratio(color(fg), composite), `${fg} / 弹窗 / ${overlay}`).toBeGreaterThanOrEqual(3)
        }
      }
    })

    it('开启状态的开关滑块与强调色轨道达到 3:1', () => {
      expect(ratio(color('on-accent'), color('accent'))).toBeGreaterThanOrEqual(3)
    })

    it('毛玻璃导航的两档文字在染色表面上满足 4.5:1', () => {
      const glass = block.match(/--t-nav-bg: rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)/)!
      const tint: Rgb = [Number(glass[1]), Number(glass[2]), Number(glass[3])]
      for (const bg of ['bg', 'surface', 'surface-raised']) {
        const composite = blend(tint, color(bg), Number(glass[4]) / 100)
        for (const fg of ['nav-fg', 'nav-muted']) {
          expect(ratio(color(fg), composite), `${fg} / ${bg}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    })
  })
}
