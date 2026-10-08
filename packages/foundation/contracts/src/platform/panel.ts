/** 面板安装版自身的网络、版本和维护任务协议。固定端口仅作为默认值。 */
export const DEFAULT_PANEL_PORTS = { frontendPort: 48100, backendPort: 48101 } as const
export type PanelPorts = { frontendPort: number; backendPort: number }
export type PanelUpdateChannel = 'commit' | 'release'
export const PANEL_UPDATE_CHANNEL_LABELS: Record<PanelUpdateChannel, string> = {
  commit: '最新提交', release: '最新发版',
}
export type PanelTaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled-back' | 'recovery-failed'
export type PanelTask = {
  id: string; kind: 'ports' | 'restart' | 'update'; state: PanelTaskState; phase: string
  createdAt: string; updatedAt: string; oldPorts: PanelPorts; newPorts: PanelPorts
  targetCommit: string; error: string
  /** 旧任务未记录更新策略；缺省按最新提交解释。 */
  updateChannel?: PanelUpdateChannel; releaseTag?: string
}
export type PanelInfo = {
  ports: PanelPorts; commit: string; buildTime: string; repository: string
  available: boolean; reason: string; activeTask: PanelTask | null; lastTask: PanelTask | null
}
export type PanelUpdate = {
  repository: string; branch: string; currentCommit: string; targetCommit: string
  channel: PanelUpdateChannel; releaseTag: string; message: string; available: boolean
}
export type PanelUpdateTarget = Pick<PanelUpdate, 'channel' | 'targetCommit' | 'releaseTag'>
export type PanelTaskReport = { task: PanelTask; logs: string; nextOffset: number; hasMore?: boolean }
/** 所选更新来源的一条提交，从新到旧排列，供面板的更新日志窗口呈现。 */
export type PanelCommit = { sha: string; message: string; time: string }
export function panelTaskIsActive(task: PanelTask): boolean { return task.state === 'queued' || task.state === 'running' }
export function validatePanelPorts(ports: PanelPorts): string | null {
  if (![ports.frontendPort, ports.backendPort].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) return '端口必须是 1–65535 的整数'
  if (ports.frontendPort === ports.backendPort) return '前端与后端端口不能相同'
  return null
}
export const PANEL_TASK_PHASE_LABELS: Record<string, string> = {
  checking: '检查部署环境', downloading: '下载源码', building: '构建新版本', firewall: '调整防火墙',
  stopping: '停止面板', activating: '切换配置与版本', verifying: '检查服务健康', finished: '已结束',
}
export const PANEL_TASK_STATE_LABELS: Record<PanelTaskState, string> = {
  queued: '等待执行', running: '正在执行', succeeded: '已完成', failed: '执行失败',
  'rolled-back': '已恢复原配置或版本', 'recovery-failed': '恢复失败，需要在服务器处理',
}
