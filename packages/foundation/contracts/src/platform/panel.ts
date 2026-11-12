/** 面板安装版自身的网络、版本和维护任务协议。固定端口仅作为默认值。 */
export const DEFAULT_PANEL_PORTS = { frontendPort: 48100, backendPort: 48101 } as const
export type PanelPorts = { frontendPort: number; backendPort: number }
export type PanelUpdateChannel = 'commit' | 'release'
export const PANEL_UPDATE_CHANNEL_LABELS: Record<PanelUpdateChannel, string> = {
  commit: '最新提交', release: '最新发版',
}
export type PanelUpdateSource = 'github' | 'gitee'
/** 更新来源固定绑定到检查、预检、任务和原请求。 */
export type PanelHistoricalUpdateSource = PanelUpdateSource
export const PANEL_UPDATE_SOURCE_LABELS: Record<PanelHistoricalUpdateSource, string> = {
  github: 'GitHub', gitee: 'Gitee',
}
export type PanelTaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled-back' | 'recovery-failed'
/** 当前安装包的实测下载进度；百分比不代表整个维护任务的进度。 */
export type PanelDownloadProgress = {
  fileName: string; status: 'downloading' | 'verifying' | 'ready'
  completedBytes: number; totalBytes: number; bytesPerSecond: number; updatedAt: string
}
export type PanelTask = {
  download?: PanelDownloadProgress
  failedPhase?: string
  cliRegistration?: { status: 'pending' | 'succeeded' | 'failed'; error?: string }
  id: string; kind: 'ports' | 'restart' | 'update'; state: PanelTaskState; phase: string
  createdAt: string; updatedAt: string; oldPorts: PanelPorts; newPorts: PanelPorts
  targetCommit: string; error: string
  /** 旧任务可能未记录更新来源或策略；保留原来源用于精确请求对账。 */
  updateChannel?: PanelUpdateChannel; updateSource?: PanelHistoricalUpdateSource; releaseTag?: string
  /** 服务端核对的派生标志：任务仍在活动态但维护单元已退出（疑似中断），终态由服务端判定后回传。 */
  workerDead?: boolean
  workerStatus?: 'alive' | 'dead' | 'unknown'
}
export type PanelInfo = {
  ports: PanelPorts; commit: string; buildTime: string; repository: string
  available: boolean; reason: string; activeTask: PanelTask | null; lastTask: PanelTask | null
  updateDelivery?: 'precompiled/v1'
  resourcePreflightVersion?: number
}
export type PanelUpdate = {
  repository: string; branch: string; currentCommit: string; targetCommit: string
  channel: PanelUpdateChannel; source: PanelUpdateSource; releaseTag: string; message: string; available: boolean
}
export type PanelResourcePlan = { preflightId: string; targets: string[]; stopPanel: boolean }
export type PanelResourceCandidate = { id: string; kind: 'container' | 'service'; name: string; memoryBytes: number | null; recommended: boolean; disabledReason?: string }
export type PanelUpdatePreflight = {
  id: string; expiresAt: string
  memory: { totalBytes: number; availableBytes: number; requiredBytes: number; swapTotalBytes: number; swapFreeBytes: number }
  disk: { availableBytes: number }; load: [number, number, number]; activeAgentRuns: number
  candidates: PanelResourceCandidate[]; needsRelease: boolean; stopPanelRecommended: boolean; blockedReason?: string
}
/** source 在旧标签页保存的待确认请求中可以缺省；新请求始终携带明确来源。 */
export type PanelUpdateTarget = Pick<PanelUpdate, 'channel' | 'targetCommit' | 'releaseTag'> & { source?: PanelHistoricalUpdateSource; resourcePlan?: PanelResourcePlan }
export type PanelTaskReport = { task: PanelTask; logs: string; nextOffset: number; hasMore?: boolean }
/** 所选发布平台的一条提交，从新到旧排列，供面板的更新日志窗口呈现。 */
export type PanelCommit = { sha: string; message: string; time: string }
export function panelTaskIsActive(task: PanelTask): boolean { return task.state === 'queued' || task.state === 'running' }
export function validatePanelPorts(ports: PanelPorts): string | null {
  if (![ports.frontendPort, ports.backendPort].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) return '端口必须是 1–65535 的整数'
  if (ports.frontendPort === ports.backendPort) return '前端与后端端口不能相同'
  return null
}
export const PANEL_TASK_PHASE_LABELS: Record<string, string> = {
  'downloading-release': '下载安装包', 'preparing-release': '校验并准备新版本',
  checking: '检查部署环境', downloading: '下载源码', building: '构建新版本', firewall: '调整防火墙',
  stopping: '停止面板并备份数据', activating: '切换配置与版本', verifying: '检查服务健康', finished: '已结束',
  'preparing-resources': '准备更新资源', 'restoring-resources': '恢复临时停止的业务',
}
export const PANEL_TASK_STATE_LABELS: Record<PanelTaskState, string> = {
  queued: '等待执行', running: '正在执行', succeeded: '已完成', failed: '执行失败',
  'rolled-back': '已恢复原配置或版本',
  'recovery-failed': '恢复失败，需要在服务器处理：执行 systemctl restart elysian 触发自动恢复，并用 journalctl -u elysian-maintenance-<任务编号> 查看现场',
}
