import type { WebsiteProject, WebsiteProjectCreateInput } from '@elysian/contracts'
import { isValidWebsiteProjectName, websiteProjectUsesPort } from '@elysian/contracts'

/*
 * 网站部署演示数据集。种子行手工固定（名称、端口、到期时间取自真实样例），确定性可复现；
 * 会话内的增删改落在这份内存数据上，刷新回到种子状态。
 * 运行状态、证书状态与到期时间是彼此独立的事实：到期早不代表已过期，
 * 种子里刻意混排，保证「快到期」「已过期」「未部署」「已停止」等界面差异同屏可见。
 */

export const SEED_PROJECTS: readonly WebsiteProject[] = [
  // Java 项目：部署命令是这一组的辨识信息，端口与 jar 名对应。
  { id: 'website-java-order-api', kind: 'java', name: '订单中心-api', pid: 23180, port: 8080, runtimeVersion: null, rootDir: '/www/wwwroot/order-api', runState: 'running', expiryAt: '2026-12-20', note: '商城核心下单链路', cert: 'deployed', category: 'production', deployCommand: 'java -jar order-api.jar --server.port=8080', traffic: { todayMb: 864, totalGb: 218.4 } },
  { id: 'website-java-user-web', kind: 'java', name: '用户中心-web', pid: 23181, port: 8081, runtimeVersion: null, rootDir: '/www/wwwroot/user-web', runState: 'running', expiryAt: '2026-11-08', note: null, cert: 'deployed', category: 'production', deployCommand: 'java -jar user-web.jar --server.port=8081', traffic: { todayMb: 512, totalGb: 96.2 } },
  { id: 'website-java-notify-job', kind: 'java', name: '消息推送-job', pid: null, port: 8082, runtimeVersion: null, rootDir: '/www/wwwroot/notify-job', runState: 'stopped', expiryAt: '2026-09-30', note: '每日推送批处理', cert: 'none', category: 'testing', deployCommand: 'java -jar notify-job.jar --server.port=8082', traffic: { todayMb: 0, totalGb: 12.6 } },
  { id: 'website-java-legacy-gateway', kind: 'java', name: '老网关', pid: null, port: 8090, runtimeVersion: null, rootDir: '/www/wwwroot/legacy-gateway', runState: 'stopped', expiryAt: '2026-08-01', note: '已由新网关替代，待下线', cert: 'expired', category: 'development', deployCommand: 'java -jar legacy-gateway.jar --server.port=8090', traffic: { todayMb: 0, totalGb: 3.1 } },
  // Node 项目：运行时版本是这一组的辨识信息，启动方式覆盖 node 直跑与 npm 脚本两种。
  { id: 'website-node-marketing', kind: 'node', name: 'marketing-site', pid: 18422, port: 3000, runtimeVersion: '20.11.1', rootDir: '/www/wwwroot/marketing-site', runState: 'running', expiryAt: '2027-03-15', note: '官网与落地页', cert: 'deployed', category: 'production', deployCommand: 'node dist/main.js', traffic: { todayMb: 731, totalGb: 164.9 } },
  { id: 'website-node-admin', kind: 'node', name: 'admin-console', pid: 18435, port: 3001, runtimeVersion: '22.4.0', rootDir: '/www/wwwroot/admin-console', runState: 'running', expiryAt: null, note: '运营后台，长期有效', cert: 'expired', category: 'testing', deployCommand: 'npm run start', traffic: { todayMb: 42, totalGb: 8.6 } },
  { id: 'website-node-webhook', kind: 'node', name: 'webhook-gateway', pid: null, port: 3100, runtimeVersion: '18.19.1', rootDir: '/www/wwwroot/webhook-gateway', runState: 'stopped', expiryAt: '2026-10-01', note: null, cert: 'none', category: 'development', deployCommand: 'node dist/server.js', traffic: { todayMb: 0, totalGb: 1.2 } },
  { id: 'website-node-socket', kind: 'node', name: 'realtime-socket', pid: 18501, port: 3200, runtimeVersion: '20.11.1', rootDir: '/www/wwwroot/realtime-socket', runState: 'running', expiryAt: '2026-09-25', note: 'WebSocket 网关', cert: 'deployed', category: 'production', deployCommand: 'node dist/main.js', traffic: { todayMb: 946, totalGb: 287.3 } },
  // Go 项目：单二进制加配置文件启动，没有到期时间，列表最精简。
  { id: 'website-go-log-collector', kind: 'go', name: 'log-collector', pid: null, port: null, runtimeVersion: null, rootDir: '/www/wwwroot/log-collector', runState: 'running', expiryAt: null, note: '日志采集 Agent', cert: 'deployed', category: 'production', deployCommand: './log-collector --config /etc/log-collector.yaml', traffic: { todayMb: 1284, totalGb: 402.6 } },
  { id: 'website-go-metrics', kind: 'go', name: 'metrics-agent', pid: null, port: null, runtimeVersion: null, rootDir: '/www/wwwroot/metrics-agent', runState: 'stopped', expiryAt: null, note: null, cert: 'none', category: 'testing', deployCommand: './metrics-agent --config /etc/metrics-agent.yaml', traffic: { todayMb: 0, totalGb: 4.5 } },
  { id: 'website-go-backup-sync', kind: 'go', name: 'backup-sync', pid: null, port: null, runtimeVersion: null, rootDir: '/www/wwwroot/backup-sync', runState: 'running', expiryAt: null, note: '定时备份同步', cert: 'none', category: 'development', deployCommand: './backup-sync --config /etc/backup-sync.yaml', traffic: { todayMb: 18, totalGb: 2.7 } },
  // Python 项目：uvicorn 承载 ASGI 应用，模块名由目录名下划线化。
  { id: 'website-python-report', kind: 'python', name: 'data-report-api', pid: null, port: null, runtimeVersion: null, rootDir: '/www/wwwroot/data-report-api', runState: 'running', expiryAt: '2026-12-01', note: '报表数据接口', cert: 'deployed', category: 'production', deployCommand: 'uvicorn data_report:app --host 0.0.0.0 --port 8000', traffic: { todayMb: 356, totalGb: 74.8 } },
  { id: 'website-python-crawler', kind: 'python', name: 'crawler-worker', pid: null, port: null, runtimeVersion: null, rootDir: '/www/wwwroot/crawler-worker', runState: 'stopped', expiryAt: '2026-09-28', note: '竞品价格采集', cert: 'none', category: 'testing', deployCommand: 'uvicorn crawler_worker:app --host 0.0.0.0 --port 8001', traffic: { todayMb: 0, totalGb: 9.4 } },
  { id: 'website-python-inference', kind: 'python', name: 'ml-inference', pid: null, port: null, runtimeVersion: null, rootDir: '/www/wwwroot/ml-inference', runState: 'running', expiryAt: '2026-10-30', note: '模型推理服务', cert: 'expired', category: 'production', deployCommand: 'uvicorn ml_inference:app --host 0.0.0.0 --port 8002', traffic: { todayMb: 608, totalGb: 133.5 } },
  // HTML 项目：挂在 Web 服务（Nginx）下的静态站，没有部署命令，生产站流量可观。
  { id: 'website-html-portal', kind: 'html', name: 'company-portal', pid: null, port: null, runtimeVersion: null, rootDir: '/www/wwwroot/company-portal', runState: 'running', expiryAt: '2027-06-30', note: '企业官网静态页', cert: 'deployed', category: 'production', deployCommand: null, traffic: { todayMb: 264, totalGb: 58.2 } },
  { id: 'website-html-docs', kind: 'html', name: 'docs-mirror', pid: null, port: null, runtimeVersion: null, rootDir: '/www/wwwroot/docs-mirror', runState: 'stopped', expiryAt: null, note: '内部文档镜像，长期有效', cert: 'none', category: 'development', deployCommand: null, traffic: { todayMb: 0, totalGb: 0.6 } },
  { id: 'website-html-promo', kind: 'html', name: 'promo-landing', pid: null, port: null, runtimeVersion: null, rootDir: '/www/wwwroot/promo-landing', runState: 'running', expiryAt: '2026-09-20', note: '活动页，活动结束后下线', cert: 'expired', category: 'testing', deployCommand: null, traffic: { todayMb: 25, totalGb: 1.8 } },
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

/**
 * 新建项目的部署命令缺省：按类型从名称与端口推导，HTML 静态站没有部署命令。
 * 端口只有 Java 与 Node 接受，缺省落到各类型最常用的监听端口。
 */
function defaultDeployCommand(
  kind: WebsiteProject['kind'],
  name: string,
  port: number | null,
): string | null {
  switch (kind) {
    case 'html':
      return null
    case 'java':
      return `java -jar ${name}.jar --server.port=${port ?? 8080}`
    case 'node':
      return 'npm run start'
    case 'go':
      return `./${name} --config /etc/${name}.yaml`
    case 'python':
      return `uvicorn ${name.replaceAll('-', '_')}:app --host 0.0.0.0 --port ${port ?? 8000}`
  }
}

export function addWebsiteProject(
  kind: WebsiteProject['kind'],
  input: WebsiteProjectCreateInput,
): WebsiteProject {
  const name = input.name.trim()
  if (!isValidWebsiteProjectName(name)) {
    throw new Error('项目名称需为 1-64 个字符')
  }
  if (projects.some((project) => project.kind === kind && project.name === name)) {
    throw new Error(`项目已存在：${name}`)
  }
  // 端口只有 Java 与 Node 接受，其余类型即使传入也忽略，与卡片的呈现口径一致。
  const port = websiteProjectUsesPort(kind) ? (input.port ?? null) : null
  const project: WebsiteProject = {
    id: `website-${kind}-${name}`,
    kind,
    name,
    pid: null,
    port,
    runtimeVersion: null,
    rootDir: input.rootDir?.trim() || `/www/wwwroot/${name}`,
    runState: 'stopped',
    expiryAt: null,
    note: input.note ?? null,
    cert: 'none',
    category: 'development',
    deployCommand: defaultDeployCommand(kind, name, port),
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
  // PID 只用于 Java 与 Node 的展示信息：其余类型运行中也保持 null。
  const pid =
    running && websiteProjectUsesPort(existing.kind) ? pseudoPid(existing.id) : null
  const next: WebsiteProject = { ...existing, runState: running ? 'running' : 'stopped', pid }
  projects = projects.map((project) => (project.id === projectId ? next : project))
  return { ...next }
}

/**
 * 项目运行日志：按项目字段生成确定性模板行，无时间戳、无随机，详情抽屉按需拉取。
 * 运行中的项目给启动完成与最近几条访问/任务/警告；已停止的项目只留停止事实。
 */
export function getWebsiteLogs(projectId: string): readonly string[] {
  const project = projects.find((item) => item.id === projectId)
  if (!project) throw new Error(`未找到项目 ${projectId}`)
  if (project.runState === 'stopped') {
    return [
      `[${project.name}] 已停止`,
      project.port === null ? '进程已退出，无监听端口' : `端口 ${project.port} 已释放`,
    ]
  }
  if (project.kind === 'html') {
    // HTML 静态站没有自己的进程：由 Web 服务（Nginx）直接提供文件服务。
    return [
      `[${project.name}] 由 Nginx 直接提供服务`,
      `站点目录 ${project.rootDir}`,
      'GET / 200',
      'GET /assets/style.css 200',
    ]
  }
  return [
    project.port === null
      ? `[${project.name}] 启动完成：${project.deployCommand}`
      : `[${project.name}] 启动完成，监听端口 ${project.port}`,
    'GET /health 200',
    'GET /api/overview 200',
    '任务：定时巡检完成，无异常',
    '警告：/api/list 平均耗时 812ms，超过关注阈值',
    project.pid === null
      ? '运行中：前台进程持续工作'
      : `运行中：进程 PID ${project.pid}`,
  ]
}
