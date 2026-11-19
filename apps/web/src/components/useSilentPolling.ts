import { useEffect, useRef, useState } from 'react'

type PollTask = (signal: AbortSignal) => Promise<void>

/*
 * 页面静默回读，不驱动手动刷新按钮。
 * - setTimeout 链而非 setInterval：下一次在上一次完成后才排，绝不重叠；
 * - 默认后台暂停，恢复可见时立即补跑一轮；
 * - 连续失败退避 ×2 至上限（默认 60 秒），成功即复位回正常节奏；
 * - degraded 供调用方展示连接中断状态；
 * - 卸载清定时器并 abort 当轮请求；task 抛错即记一次失败，不向上冒泡。
 */

export type UseSilentPollingOptions = {
  /** 正常节奏（毫秒）。 */
  intervalMs: number
  /** 退避上限（毫秒），默认 60000。 */
  maxBackoffMs?: number
  /** false 时停止轮询（如页面无活跃实体）。 */
  enabled?: boolean
  /** true 时挂载即先跑一轮（默认先等一个节奏，首轮加载由页面自己的 load 承担）。 */
  immediate?: boolean
  /** 默认在后台暂停；需要保持原后台节奏的调用方可设为 false。 */
  pauseOnHidden?: boolean
  /** 可选的回读动作，在窗口聚焦或页面恢复可见时替代定时任务。 */
  onFocus?: PollTask
}

export function useSilentPolling(
  task: PollTask,
  options: UseSilentPollingOptions,
): { degraded: boolean } {
  const [degraded, setDegraded] = useState(false)
  const tasksRef = useRef({ task, onFocus: options.onFocus })
  // Effect 换代时旧请求可能尚未响应 abort；跨代保留在途 Promise，避免新周期重叠。
  const activeTaskRef = useRef<Promise<void> | undefined>(undefined)
  tasksRef.current = { task, onFocus: options.onFocus }
  const intervalMs = options.intervalMs
  const maxBackoffMs = options.maxBackoffMs ?? 60_000
  const enabled = options.enabled !== false
  const immediate = options.immediate === true
  const pauseOnHidden = options.pauseOnHidden !== false
  const refreshOnFocus = options.onFocus !== undefined

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    let cancelled = false
    let failures = 0
    let inFlight = false
    const isHidden = () => pauseOnHidden && document.hidden

    const run = async (readOnFocus = false) => {
      if (cancelled || isHidden() || inFlight) return
      inFlight = true
      let delay = intervalMs
      let pending: Promise<void> | undefined
      try {
        if (activeTaskRef.current) await activeTaskRef.current.catch(() => {})
        if (cancelled || isHidden()) return
        const { task, onFocus } = tasksRef.current
        const read = readOnFocus ? onFocus ?? task : task
        controller = new AbortController()
        const signal = controller.signal
        pending = Promise.resolve().then(() => read(signal))
        activeTaskRef.current = pending
        await pending
        if (cancelled) return
        failures = 0
        setDegraded(false)
      } catch {
        if (cancelled) return
        failures += 1
        setDegraded(true)
        delay = Math.min(intervalMs * 2 ** failures, maxBackoffMs)
      } finally {
        if (pending && activeTaskRef.current === pending) activeTaskRef.current = undefined
        inFlight = false
        schedule(delay)
      }
    }

    const schedule = (delay: number) => {
      if (cancelled || isHidden() || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void run()
      }, delay)
    }

    const onFocus = () => { void run(true) }
    const onVisibility = () => {
      if (document.hidden) {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      } else if (refreshOnFocus) {
        onFocus()
      } else if (!cancelled && !inFlight && timer === undefined) schedule(0)
    }
    if (pauseOnHidden) document.addEventListener('visibilitychange', onVisibility)
    if (refreshOnFocus) window.addEventListener('focus', onFocus)

    schedule(immediate ? 0 : intervalMs)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      controller?.abort()
      if (pauseOnHidden) document.removeEventListener('visibilitychange', onVisibility)
      if (refreshOnFocus) window.removeEventListener('focus', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, maxBackoffMs, enabled, immediate, pauseOnHidden, refreshOnFocus])

  return { degraded }
}
