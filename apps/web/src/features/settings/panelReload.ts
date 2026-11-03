/** 每个标签页保存自己的截止时间，重新挂载或重复终态不能重新开始计时。 */
export const PANEL_RELOAD_KEY = 'elysian.panel-update-reload.v1'
export const PANEL_RELOAD_DELAY_MS = 30_000
export type PanelReload = {
  version: 1
  taskId: string
  targetCommit: string
  deadline: number
  executed: boolean
}

export function frontendCommit(): string {
  const value = import.meta.env.ELYSIAN_BUILD_COMMIT ?? ''
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : ''
}

export function readPanelReload(): PanelReload | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PANEL_RELOAD_KEY) ?? 'null') as PanelReload | null
    if (value?.version === 1 && typeof value.taskId === 'string' && value.taskId.length > 0
      && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.targetCommit)
      && Number.isFinite(value.deadline) && value.deadline > 0 && typeof value.executed === 'boolean') return value
  } catch { /* 存储不可用时仍在内存中完成本次倒计时。 */ }
  return null
}

export function savePanelReload(value: PanelReload | null): void {
  try {
    if (value) sessionStorage.setItem(PANEL_RELOAD_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(PANEL_RELOAD_KEY)
  } catch { /* 禁用存储不妨碍当前页面自动重载。 */ }
}
