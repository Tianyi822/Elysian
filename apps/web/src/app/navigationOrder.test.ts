import { describe, expect, it } from 'vitest'
import { NAV_ITEMS } from './navigation'
import { clampMovableSlot, mergeNavOrder, moveItem, moveNavItem, slotIndexAtPoint, translateForSlot } from './navigationOrder'

const KNOWN = ['/', '/security', '/docker', '/databases'] as const

describe('导航顺序合并', () => {
  it('没有存过顺序时沿用默认顺序', () => {
    expect(mergeNavOrder(KNOWN, null)).toEqual(['/', '/security', '/docker', '/databases'])
  })

  it('按已存顺序排列，丢掉不认识的路径，缺的项按默认顺序补在末尾，仪表盘固定第一', () => {
    expect(mergeNavOrder(KNOWN, ['/databases', '/missing', '/databases', '/', '/files'])).toEqual([
      '/',
      '/databases',
      '/security',
      '/docker',
    ])
  })

  it('已存顺序把仪表盘放在后面时，读出来仍在第一位', () => {
    expect(mergeNavOrder(KNOWN, ['/docker', '/security', '/'])).toEqual(['/', '/docker', '/security', '/databases'])
  })

  it('已存偏好不含导航新增项（/settings）时，新项按默认顺序补在末尾，仪表盘仍在第一位', () => {
    const known = NAV_ITEMS.map((item) => item.to)
    expect(mergeNavOrder(known, ['/', '/websites'])).toEqual([
      '/',
      '/websites',
      '/security',
      '/docker',
      '/databases',
      '/files',
      '/logs',
      '/terminals',
      '/settings',
    ])
  })
})

describe('拖拽位移', () => {
  const tops = [0, 44, 88, 132]

  it('指针落在项的区间内才算进入该槽，上下都要越过交界', () => {
    expect(slotIndexAtPoint(20, tops, 44)).toBe(0)
    expect(slotIndexAtPoint(43, tops, 44)).toBe(0)
    expect(slotIndexAtPoint(44, tops, 44)).toBe(1)
    // 第 2 项中心约在 66。贴近中线的向上移动仍留在本项，要到上一项底部才换槽。
    expect(slotIndexAtPoint(66, tops, 44)).toBe(1)
    expect(slotIndexAtPoint(65, tops, 44)).toBe(1)
    expect(slotIndexAtPoint(70, tops, 44)).toBe(1)
    // 向下到下一项顶部即换槽，不必拖到下一项中线。
    expect(slotIndexAtPoint(87, tops, 44)).toBe(1)
    expect(slotIndexAtPoint(88, tops, 44)).toBe(2)
    expect(slotIndexAtPoint(120, tops, 44)).toBe(2)
    expect(slotIndexAtPoint(400, tops, 44)).toBe(3)
  })

  it('拖拽落点不得进入仪表盘那一位', () => {
    expect(clampMovableSlot(0, 4)).toBe(1)
    expect(clampMovableSlot(2, 4)).toBe(2)
    expect(clampMovableSlot(9, 4)).toBe(3)
    expect(clampMovableSlot(0, 1)).toBe(0)
  })

  it('间距无效时停在原位', () => {
    expect(slotIndexAtPoint(120, tops, 0)).toBe(0)
    expect(slotIndexAtPoint(120, [], 44)).toBe(0)
  })

  it('被拖的项跟着指针，中间的项让出一个身位，其余不动', () => {
    expect(translateForSlot(0, 0, 2, 100, 44)).toBe(100)
    expect(translateForSlot(1, 0, 2, 100, 44)).toBe(-44)
    expect(translateForSlot(2, 0, 2, 100, 44)).toBe(-44)
    expect(translateForSlot(3, 0, 2, 100, 44)).toBe(0)

    expect(translateForSlot(3, 3, 1, -80, 44)).toBe(-80)
    expect(translateForSlot(1, 3, 1, -80, 44)).toBe(44)
    expect(translateForSlot(2, 3, 1, -80, 44)).toBe(44)
    expect(translateForSlot(0, 3, 1, -80, 44)).toBe(0)
  })
})

describe('移动一项', () => {
  it('把起点插到目标下标，越界时原样返回', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b'], 0, 0)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], -1, 0)).toEqual(['a', 'b'])
  })

  it('仪表盘不能被挪走，别的项也不能插到它前面', () => {
    const order = ['/', '/security', '/docker']
    expect(moveNavItem(order, 0, 2)).toBeNull()
    expect(moveNavItem(order, 1, 0)).toBeNull()
    expect(moveNavItem(order, 2, 1)).toEqual(['/', '/docker', '/security'])
  })
})
