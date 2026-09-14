/**
 * 确定性伪随机与时间工具。
 *
 * mock 数据必须可复现：固定种子 + 固定基准时间，任何两次运行得到的都是同一份数据，
 * 测试因此不依赖当前时钟，也不依赖 Math.random。
 */

/**
 * 数据集基准时刻：所有演示时间都相对它推算，与当前时钟解耦。
 * 定义在这个无依赖的叶子模块里，dataset 与各种子数据模块都能引用而不形成循环导入。
 */
export const DATASET_BASE_TIME = '2026-09-12T08:00:00.000Z'

/** mulberry32：小而稳定的伪随机数发生器，同一 seed 必然得到同一序列。 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(rnd: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick 收到空集合')
  const index = Math.min(items.length - 1, Math.floor(rnd() * items.length))
  const value = items[index]
  if (value === undefined) throw new Error('pick 越界')
  return value
}

/** 按权重取一项，用于让严重等级、状态的分布更像真实环境。 */
export function pickWeighted<T>(rnd: () => number, entries: ReadonlyArray<readonly [T, number]>): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
  if (total <= 0) throw new Error('pickWeighted 权重之和必须为正')
  let cursor = rnd() * total
  for (const [value, weight] of entries) {
    cursor -= weight
    if (cursor <= 0) return value
  }
  const last = entries[entries.length - 1]
  if (!last) throw new Error('pickWeighted 收到空集合')
  return last[0]
}

export function intBetween(rnd: () => number, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1))
}

/** Fisher–Yates 洗牌。用同一个种子，顺序完全确定。 */
export function shuffle<T>(rnd: () => number, items: readonly T[]): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(rnd() * (index + 1))
    const current = result[index]
    const target = result[swapWith]
    if (current === undefined || target === undefined) continue
    result[index] = target
    result[swapWith] = current
  }
  return result
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString()
}

export function minutesBefore(baseIso: string, minutes: number): string {
  return addMinutes(baseIso, -minutes)
}
