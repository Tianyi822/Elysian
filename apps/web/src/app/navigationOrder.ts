import { useSyncExternalStore } from 'react'
import { NAV_ITEMS, PINNED_NAV_PATH } from './navigation'
import { mediaQuery } from '../utils/mediaQuery'
import { UI_PREFERENCES_KEY, browserPreferenceStorage, readStoredNavOrder, writeStoredNavOrder } from './theme/themePreferences'

const DEFAULT_NAV_PATHS: readonly string[] = NAV_ITEMS.map((item) => item.to)

/** 按已存路径排列已知项：不认识的丢掉，重复的忽略，缺的按默认顺序补在末尾。仪表盘再固定到第一位。 */
export function mergeNavOrder(known: readonly string[], stored: readonly string[] | null): string[] {
  const ordered = orderNavItems(
    known.map((to) => ({ to })),
    stored ?? [],
  ).map((item) => item.to)
  return pinNavPath(ordered, PINNED_NAV_PATH)
}

function pinNavPath(paths: string[], pinned: string): string[] {
  const index = paths.indexOf(pinned)
  if (index <= 0) return paths
  return [pinned, ...paths.slice(0, index), ...paths.slice(index + 1)]
}

export function orderNavItems<T extends { to: string }>(items: readonly T[], order: readonly string[]): T[] {
  const byPath = new Map(items.map((item) => [item.to, item]))
  const seen = new Set<string>()
  const ordered: T[] = []
  for (const path of order) {
    const item = byPath.get(path)
    if (!item || seen.has(path)) continue
    ordered.push(item)
    seen.add(path)
  }
  for (const item of items) {
    if (!seen.has(item.to)) ordered.push(item)
  }
  return ordered
}

/**
 * 指针落在哪一项的区间里，落点就是哪一项。区间从该项顶部到下一项顶部。
 * 拖拽手柄在行的正中，所以上下都要再移动约半个身位、越过与相邻项的交界，才会换槽。
 * 间距无效时停在第一项。
 */
export function slotIndexAtPoint(clientY: number, slotTops: readonly number[], stride: number): number {
  if (slotTops.length === 0 || stride <= 0) return 0
  let index = 0
  for (let i = 0; i < slotTops.length; i++) {
    const top = slotTops[i]
    if (top !== undefined && clientY >= top) index = i
  }
  return index
}

/** 仪表盘占第 0 位且不可排序，拖拽落点不得进入这一位。 */
export function clampMovableSlot(index: number, length: number): number {
  if (length <= 1) return 0
  return Math.min(Math.max(index, 1), length - 1)
}

/**
 * 拖拽过程中每一项的垂直位移。
 * 被拖的项跟着指针；起点和落点之间的项让出一个身位，给它腾位置；其余保持不动。
 */
export function translateForSlot(
  index: number,
  originIndex: number,
  currentIndex: number,
  offsetY: number,
  stride: number,
): number {
  if (index === originIndex) return offsetY
  if (originIndex < currentIndex && index > originIndex && index <= currentIndex) return -stride
  if (originIndex > currentIndex && index >= currentIndex && index < originIndex) return stride
  return 0
}

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items.slice()
  const next = items.slice()
  const [item] = next.splice(from, 1)
  if (item === undefined) return items.slice()
  next.splice(to, 0, item)
  return next
}

/** 移动主导航的一项。仪表盘固定在第一位，把它当作起点或落点时不改顺序。 */
export function moveNavItem(items: readonly string[], from: number, to: number): string[] | null {
  const pinned = items.indexOf(PINNED_NAV_PATH)
  if (pinned !== -1 && (from === pinned || to === pinned)) return null
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return null
  return moveItem(items, from, to)
}

/**
 * 键盘调整顺序后的让位动画。先把每项拽回旧位置，强制回流后再过渡到新位置，
 * 避免列表重排的那一帧直接跳过去。调用方要在浏览器绘制前执行。
 */
export function playNavFlip(list: HTMLElement, previousTops: ReadonlyMap<string, number>): void {
  if (mediaQuery('(prefers-reduced-motion: reduce)')?.matches) {
    return
  }
  const nodes = [...list.querySelectorAll<HTMLElement>('[data-nav-item]')]
  const moving: HTMLElement[] = []
  for (const node of nodes) {
    const id = node.dataset['navItem']
    if (!id) continue
    const before = previousTops.get(id)
    if (before === undefined) continue
    const delta = before - node.getBoundingClientRect().top
    if (delta === 0) continue
    node.style.transition = 'none'
    node.style.transform = `translateY(${delta}px)`
    moving.push(node)
  }
  if (moving.length === 0) return
  list.getBoundingClientRect()
  for (const node of moving) {
    node.style.transition = 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)'
    node.style.transform = ''
    node.addEventListener(
      'transitionend',
      () => {
        node.style.transition = ''
      },
      { once: true },
    )
  }
}

const listeners = new Set<() => void>()
let cachedRaw: string | null | undefined
let snapshot: readonly string[] = DEFAULT_NAV_PATHS

function readRaw(): string | null {
  try {
    return browserPreferenceStorage.getItem(UI_PREFERENCES_KEY)
  } catch {
    return null
  }
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index])
}

export function getNavOrderSnapshot(): readonly string[] {
  const raw = readRaw()
  if (raw === cachedRaw) return snapshot
  cachedRaw = raw
  const next = mergeNavOrder(DEFAULT_NAV_PATHS, readStoredNavOrder(browserPreferenceStorage))
  if (samePaths(next, snapshot)) return snapshot
  snapshot = next
  return snapshot
}

function getDefaultNavOrder(): readonly string[] {
  return DEFAULT_NAV_PATHS
}

export function subscribeNavOrder(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function commitNavOrder(order: readonly string[]): void {
  writeStoredNavOrder(browserPreferenceStorage, order)
  cachedRaw = readRaw()
  const next = mergeNavOrder(DEFAULT_NAV_PATHS, readStoredNavOrder(browserPreferenceStorage))
  snapshot = samePaths(next, snapshot) ? snapshot : next
  for (const listener of listeners) listener()
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== UI_PREFERENCES_KEY) return
    cachedRaw = undefined
    getNavOrderSnapshot()
    for (const listener of listeners) listener()
  })
}

/** 侧边栏与抽屉共用的导航顺序。真源是界面偏好，两处挂载读到的是同一份。 */
export function useNavOrder(): readonly string[] {
  return useSyncExternalStore(subscribeNavOrder, getNavOrderSnapshot, getDefaultNavOrder)
}
