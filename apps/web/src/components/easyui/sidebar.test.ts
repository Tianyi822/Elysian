import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync('src/components/easyui/sidebar.css', 'utf8')
/** 1440px 起的宽屏档位。jsdom 不套用外部样式表，这里直接核对样式表原文。 */
const wide = css.split('@media (min-width: 1440px) {')[1]!

function declaration(selector: string, property: string): string | undefined {
  const pattern = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = wide.match(new RegExp(`${pattern} \\{([^}]*)\\}`))?.[1]
  return body?.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`))?.[1]
}

const px = (value: string | undefined) => Number(value?.replace('px', ''))

describe('桌面主导航宽屏档位的行距', () => {
  const rowGap = declaration('.desktop-navigation .sidebar-row-group', 'row-gap')

  it('行距为 8px，与行内上下留白、圆角和内距同一节拍', () => {
    expect(rowGap).toBe('8px')
  })

  it('底部各段之间的间距不小于行距，整条侧栏一个节奏', () => {
    const sectionGap = declaration('.desktop-navigation .sidebar-rail > :not(:last-child)', 'margin-block-end')
    expect(px(sectionGap)).toBeGreaterThanOrEqual(px(rowGap))
  })
})
