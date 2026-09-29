import { describe, expect, it } from 'vitest'
import { mergeNavOrder, moveItem, slotIndexAtPoint, translateForSlot } from './navigationOrder'

const KNOWN = ['/', '/security', '/docker', '/databases'] as const

describe('导航顺序合并', () => {
  it('没有存过顺序时沿用默认顺序', () => {
    expect(mergeNavOrder(KNOWN, null)).toEqual(['/', '/security', '/docker', '/databases'])
  })

  it('按已存顺序排列，丢掉不认识的路径，缺的项按默认顺序补在末尾', () => {
    expect(mergeNavOrder(KNOWN, ['/databases', '/missing', '/databases', '/', '/files'])).toEqual([
      '/databases',
      '/',
      '/security',
      '/docker',
    ])
  })
})

describe('拖拽位移', () => {
  const tops = [0, 44, 88, 132]

  it('指针越过槽位中线才算进入该槽', () => {
    expect(slotIndexAtPoint(20, tops, 44)).toBe(0)
    expect(slotIndexAtPoint(70, tops, 44)).toBe(1)
    expect(slotIndexAtPoint(120, tops, 44)).toBe(2)
    expect(slotIndexAtPoint(400, tops, 44)).toBe(3)
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
})
