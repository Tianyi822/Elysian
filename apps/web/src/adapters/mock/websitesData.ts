import type { WebsiteProject, WebsiteProjectCreateInput } from '@elysian/contracts'
import {
  isValidWebsiteDomain,
  isValidWebsitePort,
  isValidWebsiteProjectName,
  websiteDefaultDeployCommand,
  websiteProjectRootDir,
  websiteProjectUsesRuntime,
} from '@elysian/contracts'

/*
 * 网站部署演示数据集。种子行手工固定，确定性可复现；会话内的增删改落在
 * 这份内存数据上，刷新回到种子状态。非 HTML 站点带确定性容器 ID（64 位
 * 十六进制），HTML 静态站无容器；部分站点绑定域名（cert 语义与之自洽：
 * deployed/expired 必有域名，none 含「已绑定但路由未下发」的演示行）；
 * 新建项目的部署命令来自契约的 websiteDefaultDeployCommand（单一事实来源）。
 */

/** 由项目标识推导确定性的 64 位十六进制容器 ID：同一项目每次得到同一值，可复现。 */
function seedContainerId(id: string): string {
  let hex = ''
  for (let i = 0; i < 64; i += 1) {
    const code = id.charCodeAt(i % Math.max(1, id.length)) || 7
    hex += ((code * 31 + i * 7) % 16).toString(16)
  }
  return hex
}

export const SEED_PROJECTS: readonly WebsiteProject[] = [
  // Java 项目
  { id: 'website-java-order-api', kind: 'java', name: '订单中心-api', pid: 23180, containerId: seedContainerId('website-java-order-api'), port: 8080, runtimeVersion: '17', rootDir: websiteProjectRootDir('订单中心-api'), runState: 'running', domain: 'order.example.com', expiryAt: '2026-12-20', note: '商城核心下单链路', cert: 'deployed', category: 'production', deployCommand: 'java -jar order-api.jar --server.port=8080', gitUrl: 'https://github.com/acme/order-api.git', traffic: { todayMb: 864, totalGb: 218.4 } },
  { id: 'website-java-user-web', kind: 'java', name: '用户中心-web', pid: 23181, containerId: seedContainerId('website-java-user-web'), port: 8081, runtimeVersion: '21', rootDir: websiteProjectRootDir('用户中心-web'), runState: 'running', domain: 'user.example.com', expiryAt: '2026-11-08', note: null, cert: 'deployed', category: 'production', deployCommand: 'java -jar user-web.jar --server.port=8081', gitUrl: 'https://gitee.com/acme/user-web.git', traffic: { todayMb: 512, totalGb: 96.2 } },
  { id: 'website-java-notify-job', kind: 'java', name: '消息推送-job', pid: null, containerId: seedContainerId('website-java-notify-job'), port: 8082, runtimeVersion: '17', rootDir: websiteProjectRootDir('消息推送-job'), runState: 'stopped', domain: null, expiryAt: '2026-09-30', note: '每日推送批处理', cert: 'none', category: 'testing', deployCommand: 'java -jar notify-job.jar --server.port=8082', gitUrl: null, traffic: { todayMb: 0, totalGb: 12.6 } },
  { id: 'website-java-legacy-gateway', kind: 'java', name: '老网关', pid: null, containerId: seedContainerId('website-java-legacy-gateway'), port: 8090, runtimeVersion: '11', rootDir: websiteProjectRootDir('老网关'), runState: 'stopped', domain: 'legacy.example.com', expiryAt: '2026-08-01', note: '已由新网关替代，待下线', cert: 'expired', category: 'development', deployCommand: 'java -jar legacy-gateway.jar --server.port=8090', gitUrl: 'https://github.com/acme/legacy-gateway.git', traffic: { todayMb: 0, totalGb: 3.1 } },
  // Node 项目
  { id: 'website-node-marketing', kind: 'node', name: 'marketing-site', pid: 18422, containerId: seedContainerId('website-node-marketing'), port: 3000, runtimeVersion: '20.11.1', rootDir: websiteProjectRootDir('marketing-site'), runState: 'running', domain: 'www.acme.example.com', expiryAt: '2027-03-15', note: '官网与落地页', cert: 'deployed', category: 'production', deployCommand: 'node dist/main.js', gitUrl: 'https://github.com/acme/marketing-site.git', traffic: { todayMb: 731, totalGb: 164.9 } },
  { id: 'website-node-admin', kind: 'node', name: 'admin-console', pid: 18435, containerId: seedContainerId('website-node-admin'), port: 3001, runtimeVersion: '22.4.0', rootDir: websiteProjectRootDir('admin-console'), runState: 'running', domain: 'admin.acme.example.com', expiryAt: null, note: '运营后台，长期有效', cert: 'expired', category: 'testing', deployCommand: 'npm run start', gitUrl: null, traffic: { todayMb: 42, totalGb: 8.6 } },
  { id: 'website-node-webhook', kind: 'node', name: 'webhook-gateway', pid: null, containerId: seedContainerId('website-node-webhook'), port: 3100, runtimeVersion: '18.19.1', rootDir: websiteProjectRootDir('webhook-gateway'), runState: 'stopped', domain: null, expiryAt: '2026-10-01', note: null, cert: 'none', category: 'development', deployCommand: 'node dist/server.js', gitUrl: 'git@github.com:acme/webhook-gateway.git', traffic: { todayMb: 0, totalGb: 1.2 } },
  { id: 'website-node-socket', kind: 'node', name: 'realtime-socket', pid: 18501, containerId: seedContainerId('website-node-socket'), port: 3200, runtimeVersion: '20.11.1', rootDir: websiteProjectRootDir('realtime-socket'), runState: 'running', domain: 'socket.acme.example.com', expiryAt: '2026-09-25', note: 'WebSocket 网关', cert: 'deployed', category: 'production', deployCommand: 'node dist/main.js', gitUrl: 'https://github.com/acme/realtime-socket.git', traffic: { todayMb: 946, totalGb: 287.3 } },
  // Go 项目
  { id: 'website-go-log-collector', kind: 'go', name: 'log-collector', pid: 24001, containerId: seedContainerId('website-go-log-collector'), port: 9100, runtimeVersion: '1.22.4', rootDir: websiteProjectRootDir('log-collector'), runState: 'running', domain: 'logs.acme.example.com', expiryAt: null, note: '日志采集 Agent', cert: 'deployed', category: 'production', deployCommand: './log-collector --config /etc/log-collector.yaml', gitUrl: 'https://github.com/acme/log-collector.git', traffic: { todayMb: 1284, totalGb: 402.6 } },
  { id: 'website-go-metrics', kind: 'go', name: 'metrics-agent', pid: null, containerId: seedContainerId('website-go-metrics'), port: 9101, runtimeVersion: '1.21.5', rootDir: websiteProjectRootDir('metrics-agent'), runState: 'stopped', domain: null, expiryAt: null, note: null, cert: 'none', category: 'testing', deployCommand: './metrics-agent --config /etc/metrics-agent.yaml', gitUrl: null, traffic: { todayMb: 0, totalGb: 4.5 } },
  { id: 'website-go-backup-sync', kind: 'go', name: 'backup-sync', pid: 24003, containerId: seedContainerId('website-go-backup-sync'), port: 9102, runtimeVersion: '1.23.1', rootDir: websiteProjectRootDir('backup-sync'), runState: 'running', domain: 'backup.acme.example.com', expiryAt: null, note: '定时备份同步', cert: 'none', category: 'development', deployCommand: './backup-sync --config /etc/backup-sync.yaml', gitUrl: 'https://gitee.com/acme/backup-sync.git', traffic: { todayMb: 18, totalGb: 2.7 } },
  // Python 项目
  { id: 'website-python-report', kind: 'python', name: 'data-report-api', pid: 25001, containerId: seedContainerId('website-python-report'), port: 8000, runtimeVersion: '3.11.9', rootDir: websiteProjectRootDir('data-report-api'), runState: 'running', domain: 'report.acme.example.com', expiryAt: '2026-12-01', note: '报表数据接口', cert: 'deployed', category: 'production', deployCommand: 'uvicorn data_report:app --host 0.0.0.0 --port 8000', gitUrl: 'https://github.com/acme/data-report-api.git', traffic: { todayMb: 356, totalGb: 74.8 } },
  { id: 'website-python-crawler', kind: 'python', name: 'crawler-worker', pid: null, containerId: seedContainerId('website-python-crawler'), port: 8001, runtimeVersion: '3.10.14', rootDir: websiteProjectRootDir('crawler-worker'), runState: 'stopped', domain: null, expiryAt: '2026-09-28', note: '竞品价格采集', cert: 'none', category: 'testing', deployCommand: 'uvicorn crawler_worker:app --host 0.0.0.0 --port 8001', gitUrl: null, traffic: { todayMb: 0, totalGb: 9.4 } },
  { id: 'website-python-inference', kind: 'python', name: 'ml-inference', pid: 25003, containerId: seedContainerId('website-python-inference'), port: 8002, runtimeVersion: '3.12.4', rootDir: websiteProjectRootDir('ml-inference'), runState: 'running', domain: 'ml.acme.example.com', expiryAt: '2026-10-30', note: '模型推理服务', cert: 'expired', category: 'production', deployCommand: 'uvicorn ml_inference:app --host 0.0.0.0 --port 8002', gitUrl: 'https://github.com/acme/ml-inference.git', traffic: { todayMb: 608, totalGb: 133.5 } },
  // HTML 项目：无容器、无运行时版本，端口只登记不发布，由宿主 Caddy 直接托管。
  { id: 'website-html-portal', kind: 'html', name: 'company-portal', pid: null, containerId: null, port: 8088, runtimeVersion: null, rootDir: websiteProjectRootDir('company-portal'), runState: 'running', domain: 'www.company.example.com', expiryAt: '2027-06-30', note: '企业官网静态页', cert: 'deployed', category: 'production', deployCommand: null, gitUrl: 'https://github.com/acme/company-portal.git', traffic: { todayMb: 264, totalGb: 58.2 } },
  { id: 'website-html-docs', kind: 'html', name: 'docs-mirror', pid: null, containerId: null, port: 8089, runtimeVersion: null, rootDir: websiteProjectRootDir('docs-mirror'), runState: 'stopped', domain: null, expiryAt: null, note: '内部文档镜像，长期有效', cert: 'none', category: 'development', deployCommand: null, gitUrl: null, traffic: { todayMb: 0, totalGb: 0.6 } },
  { id: 'website-html-promo', kind: 'html', name: 'promo-landing', pid: null, containerId: null, port: 8091, runtimeVersion: null, rootDir: websiteProjectRootDir('promo-landing'), runState: 'running', domain: 'promo.acme.example.com', expiryAt: '2026-09-20', note: '活动页，活动结束后下线', cert: 'expired', category: 'testing', deployCommand: null, gitUrl: 'https://gitee.com/acme/promo-landing.git', traffic: { todayMb: 25, totalGb: 1.8 } },
]

let projects: WebsiteProject[] = SEED_PROJECTS.map((project) => ({ ...project }))

export function resetWebsitesData(): void {
  projects = SEED_PROJECTS.map((project) => ({ ...project }))
}

export function getWebsiteProjects(): readonly WebsiteProject[] {
  return projects.map((project) => ({ ...project }))
}

/** 由标识推导稳定的伪进程号：同一项目每次启动拿到同一个 PID，确定性可复现。 */
function pseudoPid(id: string): number {
  const sum = Array.from(id).reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return 10000 + (sum % 89999)
}

export function addWebsiteProject(
  kind: WebsiteProject['kind'],
  input: WebsiteProjectCreateInput,
): WebsiteProject {
  const name = input.name.trim()
  if (!isValidWebsiteProjectName(name)) {
    throw new Error('项目名称需为 1-64 个字符')
  }
  if (!isValidWebsitePort(input.port)) {
    throw new Error('端口需为 1-65535 的整数')
  }
  // 名称全局唯一：站点目录与 bind 挂载只由名称推导，跨类型同名会共享同一目录，
  // 删除其一会连带删除另一站点的全部文件，因此查重不区分类型。
  if (projects.some((project) => project.name === name)) {
    throw new Error(`项目已存在：${name}`)
  }
  const runtimeVersion = websiteProjectUsesRuntime(kind)
    ? (input.runtimeVersion?.trim() || null)
    : null
  if (websiteProjectUsesRuntime(kind) && !runtimeVersion) {
    throw new Error('请选择运行时版本')
  }
  const domain = input.domain?.trim() || null
  if (domain !== null && !isValidWebsiteDomain(domain)) {
    throw new Error('域名无效')
  }
  if (domain !== null && projects.some((project) => project.domain === domain)) {
    throw new Error(`域名已被绑定：${domain}`)
  }
  const gitUrl = input.gitUrl?.trim() || null
  const id = `website-${kind}-${name}`
  const project: WebsiteProject = {
    id,
    kind,
    name,
    pid: null,
    containerId: kind === 'html' ? null : seedContainerId(id),
    port: input.port,
    runtimeVersion,
    rootDir: websiteProjectRootDir(name),
    runState: 'stopped',
    domain,
    expiryAt: null,
    note: input.note ?? null,
    cert: 'none',
    category: 'development',
    deployCommand: websiteDefaultDeployCommand(kind, input.port),
    gitUrl,
    traffic: { todayMb: 0, totalGb: 0 },
  }
  projects = [...projects, project]
  return { ...project }
}

export function updateWebsiteProject(
  projectId: string,
  input: { note?: string | null; expiryAt?: string | null },
): WebsiteProject {
  const existing = projects.find((project) => project.id === projectId)
  if (!existing) throw new Error(`未找到项目 ${projectId}`)
  const next: WebsiteProject = {
    ...existing,
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.expiryAt !== undefined ? { expiryAt: input.expiryAt } : {}),
  }
  projects = projects.map((project) => (project.id === projectId ? next : project))
  return { ...next }
}

export function removeWebsiteProject(projectId: string): void {
  const existing = projects.find((project) => project.id === projectId)
  if (!existing) throw new Error(`未找到项目 ${projectId}`)
  projects = projects.filter((project) => project.id !== projectId)
}

export function setWebsiteProjectRunning(projectId: string, running: boolean): WebsiteProject {
  const existing = projects.find((project) => project.id === projectId)
  if (!existing) throw new Error(`未找到项目 ${projectId}`)
  // HTML 由宿主 Caddy 托管，无本进程 PID；其余类型运行中补伪进程号。
  const pid = running && existing.kind !== 'html' ? pseudoPid(existing.id) : null
  const next: WebsiteProject = { ...existing, runState: running ? 'running' : 'stopped', pid }
  projects = projects.map((project) => (project.id === projectId ? next : project))
  return { ...next }
}

/**
 * 项目运行日志：按项目字段生成确定性模板行，无时间戳、无随机，详情抽屉按需拉取。
 */
export function getWebsiteLogs(projectId: string): readonly string[] {
  const project = projects.find((item) => item.id === projectId)
  if (!project) throw new Error(`未找到项目 ${projectId}`)
  if (project.runState === 'stopped') {
    return [
      `[${project.name}] 已停止`,
      `端口 ${project.port} 已释放`,
    ]
  }
  if (project.kind === 'html') {
    return [
      `[${project.name}] 由 Caddy 直接托管`,
      `站点目录 ${project.rootDir}`,
      `监听端口 ${project.port}`,
      'GET / 200',
      'GET /assets/style.css 200',
    ]
  }
  return [
    `[${project.name}] 启动完成，监听端口 ${project.port}`,
    'GET /health 200',
    'GET /api/overview 200',
    '任务：定时巡检完成，无异常',
    '警告：/api/list 平均耗时 812ms，超过关注阈值',
    project.pid === null
      ? '运行中：前台进程持续工作'
      : `运行中：进程 PID ${project.pid}`,
  ]
}
