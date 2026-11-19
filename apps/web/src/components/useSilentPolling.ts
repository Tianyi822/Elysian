import { useEffect, useRef, useState } from 'react'
import { subscribeWhileVisible } from '../adapters/subscribeWhileVisible'

/** 返回 false 时停止定时读取，恢复可见仍会补读。 */
type PollTask = (signal: AbortSignal) => Promise<void | boolean>

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
  /** 网络恢复时立即运行一次定时任务。 */
  refreshOnOnline?: boolean
  /** 仅在后台暂停模式下，隐藏页面时也取消在途读取。 */
  abortOnHidden?: boolean
  /** 读取目标变化时结束旧周期，按初始策略启动新周期。 */
  scope?: unknown
}

export function useSilentPolling(
  task: PollTask,
  options: UseSilentPollingOptions,
): { degraded: boolean } {
  const [degraded, setDegraded] = useState(false)
  const tasksRef = useRef({ task, onFocus: options.onFocus })
  // Effect 换代时旧请求可能尚未响应 abort；跨代保留在途 Promise，避免新周期重叠。
  const activeTaskRef = useRef<ReturnType<PollTask> | undefined>(undefined)
  tasksRef.current = { task, onFocus: options.onFocus }
  const intervalMs = options.intervalMs
  const maxBackoffMs = options.maxBackoffMs ?? 60_000
  const enabled = options.enabled !== false
  const immediate = options.immediate === true
  const pauseOnHidden = options.pauseOnHidden !== false
  const refreshOnFocus = options.onFocus !== undefined
  const refreshOnOnline = options.refreshOnOnline === true
  const abortOnHidden = options.abortOnHidden === true
  const scope = options.scope

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    let cancelled = false
    let failures = 0
    let inFlight = false
    let visible = false
    let initial = true
    let repeat = true

    const run = async (readOnFocus = false) => {
      if (cancelled || !visible || inFlight) return
      inFlight = true
      let delay = intervalMs
      let pending: ReturnType<PollTask> | undefined
      let signal: AbortSignal | undefined
      try {
        if (activeTaskRef.current) await activeTaskRef.current.catch(() => {})
        if (cancelled || !visible) return
        const { task, onFocus } = tasksRef.current
        const read = readOnFocus ? onFocus ?? task : task
        controller = new AbortController()
        const requestSignal = signal = controller.signal
        pending = Promise.resolve().then(() => { if (!requestSignal.aborted) return read(requestSignal) })
        activeTaskRef.current = pending
        const result = await pending
        if (cancelled || signal.aborted) return
        repeat = result !== false
        failures = 0
        setDegraded(false)
      } catch {
        if (cancelled || signal?.aborted) return
        failures += 1
        setDegraded(true)
        delay = Math.min(intervalMs * 2 ** failures, maxBackoffMs)
      } finally {
        if (pending && activeTaskRef.current === pending) activeTaskRef.current = undefined
        controller = undefined
        inFlight = false
        schedule(signal?.aborted ? 0 : delay)
      }
    }

    const schedule = (delay: number) => {
      if (cancelled || !visible || !repeat || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void run()
      }, delay)
    }

    const onFocus = () => { void run(true) }
    const onOnline = () => { void run() }
    const start = () => {
      visible = true
      repeat = true
      if (initial && !immediate) schedule(intervalMs)
      else if (!initial && refreshOnFocus) onFocus()
      else if (immediate) void run()
      else if (!inFlight) schedule(0)
      return () => {
        visible = false
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        if (abortOnHidden) controller?.abort()
      }
    }
    const stop = pauseOnHidden ? subscribeWhileVisible(start) : start()
    initial = false
    if (refreshOnFocus) window.addEventListener('focus', onFocus)
    if (refreshOnOnline) window.addEventListener('online', onOnline)

    return () => {
      cancelled = true
      stop()
      controller?.abort()
      if (refreshOnFocus) window.removeEventListener('focus', onFocus)
      if (refreshOnOnline) window.removeEventListener('online', onOnline)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, maxBackoffMs, enabled, immediate, pauseOnHidden, refreshOnFocus, refreshOnOnline, abortOnHidden, scope])

  return { degraded }
}
