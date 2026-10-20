import type { ElysianGateway } from '../contracts/adapters'

export type ExecutionResourceChoice = { value: string; label: string; description: string }

/** 只读已有目录；名称只用于辨认，提交值始终是工具接受的资源键。 */
export async function executionResourceChoices(gateway: ElysianGateway, domain: string): Promise<ExecutionResourceChoice[]> {
  switch (domain) {
    case 'docker-container': return (await gateway.containers.list()).map(item => ({ value: item.id, label: item.name, description: item.id }))
    case 'docker-image': return (await gateway.containers.listImages()).map(item => ({ value: item.id, label: `${item.name}:${item.tag}`, description: `本机镜像 ID：${item.id}` }))
    case 'website': return (await gateway.websites.list()).projects.map(item => ({ value: item.id, label: item.name, description: item.id }))
    case 'container-app': return (await gateway.containers.listApps()).map(item => ({ value: item.slug, label: item.displayName, description: item.slug }))
    case 'database': return (await gateway.databases.list()).filter(item => item.engine !== 'SQLite').map(item => ({ value: item.id, label: item.name, description: `${item.engine} · ${item.id}` }))
    default: return []
  }
}
