import { describe, expect, it } from 'vitest'
import { advanceAuthGeneration } from '../utils/authGeneration'
import { createRequestGuard } from './requestGuard'

describe('createRequestGuard', () => {
  it('同一代次允许并行，失效后拒绝所有旧请求', () => {
    const guard = createRequestGuard()
    const first = guard.capture()
    const second = guard.capture()
    expect(first()).toBe(true)
    expect(second()).toBe(true)
    guard.invalidate()
    expect(first()).toBe(false)
    expect(second()).toBe(false)
    expect(guard.capture()()).toBe(true)
  })

  it('新请求仅取代同一个守卫里的旧请求，登录代次变化使两者失效', () => {
    const detail = createRequestGuard()
    const catalog = createRequestGuard()
    const first = detail.replace()
    const other = catalog.replace()
    const latest = detail.replace()
    expect(first()).toBe(false)
    expect(other()).toBe(true)
    expect(latest()).toBe(true)
    advanceAuthGeneration()
    expect(other()).toBe(false)
    expect(latest()).toBe(false)
    expect(detail.capture()()).toBe(true)
  })
})
