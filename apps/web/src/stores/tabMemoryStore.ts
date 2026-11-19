import { create } from 'zustand'

export type TabMemoryState<T extends string> = {
  tab: T
  setTab: (tab: T) => void
}

/** 页签仅记在页面内存中，不写 URL 或持久化；新页面从默认项开始。 */
export function createTabMemorySlice<T extends string>(defaultValue: T, set: (selection: { tab: T }) => void): TabMemoryState<T> {
  return { tab: defaultValue, setTab: (tab) => set({ tab }) }
}

export function createTabMemoryStore<T extends string>(defaultValue: T) {
  return create<TabMemoryState<T>>((set) => createTabMemorySlice(defaultValue, set))
}
