export function createAbortError(): DOMException {
  return new DOMException('操作已取消', 'AbortError')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError()
}

/** 取消时立即结束等待；原 Promise 的迟到结果仍被消费，不产生未处理的拒绝。 */
export async function awaitAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined)
    throw createAbortError()
  }
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(createAbortError())
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** 演示传输也遵循取消信号，不在停止后继续落入数据集。 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(createAbortError()); return }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(createAbortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
