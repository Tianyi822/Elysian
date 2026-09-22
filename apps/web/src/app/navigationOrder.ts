import { useSyncExternalStore } from 'react'
import { NAV_ITEMS } from './navigation'
import { UI_PREFERENCES_KEY, readStoredNavOrder, writeStoredNavOrder } from './theme/themePreferences'

const DEFAULT_NAV_PATHS: readonly string[] = NAV_ITEMS.map((item) => item.to)

/** 按已存路径排列已知项：不认识的丢掉，重复的忽略，缺的按默认顺序补在末尾。 */
export function mergeNavOrder(known: readonly string[], stored: readonly string[] | null): string[] {
  return orderNavItems(
    known.map((to) => ({ to })),
    stored ?? [],
  ).map((item) => item.to)
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

/** 指针越过槽位中线才算进该槽；间距无效时停在第一项。 */
export function slotIndexAtPoint(clientY: number, slotTops: readonly number[], stride: number): number {
  if (slotTops.length === 0 || stride <= 0) return 0
  const half = stride / 2
  let index = 0
  for (let i = 0; i < slotTops.length; i++) {
    const top = slotTops[i]
    if (top !== undefined && clientY >= top + half) index = i
  }
  return index
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

/**
 * 键盘调整顺序后的让位动画。先把每项拽回旧位置，强制回流后再过渡到新位置，
 * 避免列表重排的那一帧直接跳过去。调用方要在浏览器绘制前执行。
 */
export function playNavFlip(list: HTMLElement, previousTops: ReadonlyMap<string, number>): void {
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
    return localStorage.getItem(UI_PREFERENCES_KEY)
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
  const next = mergeNavOrder(DEFAULT_NAV_PATHS, readStoredNavOrder(localStorage))
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
  writeStoredNavOrder(localStorage, order)
  cachedRaw = readRaw()
  const next = mergeNavOrder(DEFAULT_NAV_PATHS, readStoredNavOrder(localStorage))
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
