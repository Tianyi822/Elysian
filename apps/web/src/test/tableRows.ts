import { act } from '@testing-library/react'

const live = new Set<IntersectionObserverCallback>()

/** jsdom 没有 IntersectionObserver：只登记回调，由 scrollTablesToEnd 显式驱动。 */
export class IntersectionObserverStub {
  private callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) { this.callback = callback }
  observe() { live.add(this.callback) }
  unobserve() {}
  disconnect() { live.delete(this.callback) }
  takeRecords() { return [] }
}

/** 表体滚到末尾一次：只补足下一批行。 */
export async function scrollTableBatch() {
  const callbacks = [...live]
  await act(async () => {
    for (const callback of callbacks) {
      callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    }
  })
}

/** 表体一直滚到末尾：反复触发哨兵，直到表格补足全部已加载行。 */
export async function scrollTablesToEnd() {
  for (let pass = 0; pass < 200 && live.size > 0; pass++) await scrollTableBatch()
}