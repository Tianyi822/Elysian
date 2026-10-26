type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** 仅用于可在内存中降级的界面偏好；发送标识、授权和业务数据不使用此回退。 */
export function resilientPreferenceStorage(source: () => StoragePort, onWriteFailure: () => void): StoragePort {
  const memory = new Map<string, string>()
  const unsaved = new Set<string>()
  let reported = false
  const failed = (key: string) => {
    unsaved.add(key)
    if (!reported) { reported = true; onWriteFailure() }
  }
  return {
    getItem(key) {
      if (unsaved.has(key)) return memory.get(key) ?? null
      try {
        const value = source().getItem(key)
        if (value === null) memory.delete(key)
        else memory.set(key, value)
        return value
      } catch { return memory.get(key) ?? null }
    },
    setItem(key, value) {
      memory.set(key, value)
      try { source().setItem(key, value); unsaved.delete(key); reported = false }
      catch { failed(key) }
    },
    removeItem(key) {
      memory.delete(key)
      try { source().removeItem(key); unsaved.delete(key); reported = false }
      catch { failed(key) }
    },
  }
}
