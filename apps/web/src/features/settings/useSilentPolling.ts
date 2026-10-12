import { useEffect, useRef, useState } from 'react'

/*
 * 静默轮询 hook（Agent 域无 SSE，增量全靠 JSON 分页轮询）。约定：
 * - setTimeout 链而非 setInterval：下一次在上一次完成后才排，绝不重叠；
 * - document.hidden 暂停（不排定时器），恢复可见时立即补跑一轮；
 * - 连续失败退避 ×2 至上限（默认 60 秒），成功即复位回正常节奏；
 * - degraded 暴露给页面标「连接中断，正在重试」（role=status）；
 * - 静默轮询不驱动 RefreshButton/BusyVeil（口径同 WebsitesPanel 先例）；
 * - 卸载清定时器并 abort 当轮请求；task 抛错即记一次失败，不向上冒泡。
 * 节奏基准：非终态活动实体 3 秒；挂载中的审批/列表 10–15 秒。
 */

export type UseSilentPollingOptions = {
  /** 正常节奏（毫秒）。 */
  intervalMs: number
  /** 退避上限（毫秒），默认 60000。 */
  maxBackoffMs?: number
  /** false 时暂停轮询（如页面无活跃实体）；不卸载监听。 */
  enabled?: boolean
  /** true 时挂载即先跑一轮（默认先等一个节奏，首轮加载由页面自己的 load 承担）。 */
  immediate?: boolean
}

export function useSilentPolling(
  task: (signal: AbortSignal) => Promise<void>,
  options: UseSilentPollingOptions,
): { degraded: boolean } {
  const [degraded, setDegraded] = useState(false)
  const taskRef = useRef(task)
  // Effect 换代时旧请求可能尚未响应 abort；跨代保留在途 Promise，避免新周期重叠。
  const activeTaskRef = useRef<Promise<void> | undefined>(undefined)
  taskRef.current = task
  const intervalMs = options.intervalMs
  const maxBackoffMs = options.maxBackoffMs ?? 60_000
  const enabled = options.enabled !== false
  const immediate = options.immediate === true

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    let cancelled = false
    let failures = 0
    let inFlight = false

    const run = async () => {
      if (cancelled || document.hidden || inFlight) return
      inFlight = true
      let delay = intervalMs
      let pending: Promise<void> | undefined
      try {
        if (activeTaskRef.current) await activeTaskRef.current.catch(() => {})
        if (cancelled || document.hidden) return
        controller = new AbortController()
        pending = Promise.resolve().then(() => taskRef.current(controller!.signal))
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
        if (!cancelled && !document.hidden) schedule(delay)
      }
    }

    const schedule = (delay: number) => {
      if (cancelled || document.hidden || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void run()
      }, delay)
    }

    const onVisibility = () => {
      if (document.hidden) {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      } else if (!cancelled && !inFlight && timer === undefined) schedule(0)
    }
    document.addEventListener('visibilitychange', onVisibility)

    schedule(immediate ? 0 : intervalMs)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, maxBackoffMs, enabled, immediate])

  return { degraded }
}
