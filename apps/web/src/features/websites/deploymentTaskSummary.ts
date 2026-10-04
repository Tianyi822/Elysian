import { WEBSITE_DEPLOYMENT_STATE_LABELS, type WebsiteDeploymentTask } from '@elysian/contracts'

export function deploymentTaskSummary(task: WebsiteDeploymentTask): string {
  const label = WEBSITE_DEPLOYMENT_STATE_LABELS[task.state]
  if (task.projectStatus === 'deleted') return `历史${label} · 项目已删除`
  if (!task.stage || task.stage === label || (task.state === 'succeeded' && task.stage.startsWith(label))) return label
  return `${label} · ${task.stage}`
}
