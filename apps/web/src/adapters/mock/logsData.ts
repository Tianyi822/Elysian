import type {
  LoginLogEntry,
  OperationLogEntry,
  PlatformLogLevel,
  RuntimeLogEntry,
} from '@elysian/contracts'

/*
 * 日志演示数据集。登录记录是手工固定的种子行（IP、归属地与 User-Agent 取自真实样例）；
 * 运行日志与操作日志按固定模板与固定步长生成条目，全部确定性可复现。
 * 三类都是只读事实，唯一的变更动作是按类别清空：清空改写内存数组并在其中留下一条
 * 留痕（与真实服务端同形，见规格 7.2），resetLogsData 把两个数组恢复回种子。
 *
 * 操作日志的种子**不含数据库类条目**：本期数据库域全是演示，演示动作不是审计事实
 * （规格 10.5 与 15.5）；契约里的五个分类仍由界面筛选器固定渲染，数据库槽位空着。
 */

function edgeUa(chrome: number): string {
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36 Edg/${chrome}.0.0.0`
}

const UA_CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const UA_SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15'

export const SEED_LOGIN_LOGS: readonly LoginLogEntry[] = [
  { id: 'login-01', ip: '114.139.238.152', location: '中国电信 中国 贵州 贵阳', userAgent: edgeUa(152), status: 'success', time: '2026-09-13T19:13:43' },
  { id: 'login-02', ip: '1.204.32.143', location: '中国电信 中国 贵州 贵阳', userAgent: edgeUa(152), status: 'success', time: '2026-09-13T10:02:01' },
  { id: 'login-03', ip: '1.206.183.16', location: '中国电信/基站WiFi 中国 贵州 黔南', userAgent: edgeUa(145), status: 'success', time: '2026-03-06T11:04:10' },
  { id: 'login-04', ip: '1.206.183.16', location: '中国电信/基站WiFi 中国 贵州 黔南', userAgent: edgeUa(145), status: 'success', time: '2026-03-06T10:51:04' },
  { id: 'login-05', ip: '58.16.63.158', location: '中国联通 中国 贵州 贵阳', userAgent: edgeUa(142), status: 'success', time: '2025-11-25T14:11:43' },
  { id: 'login-06', ip: '58.16.63.158', location: '中国联通 中国 贵州 贵阳', userAgent: edgeUa(142), status: 'success', time: '2025-11-25T14:09:55' },
  { id: 'login-07', ip: '114.135.25.46', location: '电信 中国 贵州 遵义', userAgent: edgeUa(140), status: 'success', time: '2025-09-22T11:16:04' },
  { id: 'login-08', ip: '114.135.25.46', location: '电信 中国 贵州 遵义', userAgent: edgeUa(140), status: 'failure', time: '2025-09-22T11:15:33' },
  { id: 'login-09', ip: '114.138.157.44', location: '电信 中国 贵州 黔南', userAgent: edgeUa(140), status: 'success', time: '2025-09-14T21:43:53' },
  { id: 'login-10', ip: '114.139.238.150', location: '电信 中国 贵州 黔南', userAgent: edgeUa(138), status: 'success', time: '2025-07-25T17:42:33' },
  // 以下为演示补充：换平台与浏览器的登录记录，补齐失败结果与 Safari 呈现。
  { id: 'login-11', ip: '223.104.63.77', location: '中国移动 中国 贵州 贵阳', userAgent: UA_CHROME_WIN, status: 'failure', time: '2025-06-18T09:20:17' },
  { id: 'login-12', ip: '117.135.169.20', location: '中国移动 中国 上海 上海', userAgent: UA_SAFARI_MAC, status: 'success', time: '2025-05-02T22:05:41' },
]

/**
 * 运行日志的十条模板：来源是英文点分的组件标识，正文是中文单行描述。
 * 按索引取模板、四个等级穿插，不引入随机数。
 */
const RUNTIME_LOG_TEMPLATES: readonly {
  level: PlatformLogLevel
  source: string
  message: string
}[] = [
  { level: 'debug', source: 'panel.announcement', message: '轮询公告列表' },
  { level: 'debug', source: 'system.load', message: '采集负载均值 load1=0.14 load5=0.22' },
  { level: 'info', source: 'system.metrics', message: '采集完成 cpu=6.2% mem=41.5% disk=63.8%' },
  { level: 'info', source: 'system.ssl', message: '证书 demo.elysian.local 距到期还有 21 天' },
  { level: 'debug', source: 'files.scan', message: '增量扫描完成 变更 0 个文件' },
  { level: 'info', source: 'system.backup', message: '凌晨备份校验通过 备份集 3 个' },
  { level: 'warning', source: 'database.mariadb', message: '检测到 2 条慢查询 最高 1.8s' },
  { level: 'debug', source: 'panel.heartbeat', message: '心跳正常 在线会话 2 个' },
  { level: 'error', source: 'system.smtp', message: '告警邮件发送失败 SMTP 535，转下个重试窗口' },
  { level: 'info', source: 'container.stats', message: '容器统计已刷新 7 个运行中' },
]

/** 固定起点按分钟推进生成 240 条（十几 KB 量级），时间戳用 UTC 书写保证确定性。 */
function buildRuntimeLogEntries(): readonly RuntimeLogEntry[] {
  const start = Date.parse('2026-09-16T11:24:54Z')
  const entries: RuntimeLogEntry[] = []
  for (let index = 0; index < 240; index += 1) {
    const at = new Date(start + index * 60_000).toISOString()
    const template = RUNTIME_LOG_TEMPLATES[index % RUNTIME_LOG_TEMPLATES.length]!
    entries.push({ id: `${at}#${index + 1}`, at, ...template })
  }
  // 模板按 index 轮转，因此先生成再倒置：条目内容与标识不变，只是最新的一条排在最前。
  return entries.reverse()
}

export const SEED_RUNTIME_LOGS: readonly RuntimeLogEntry[] = buildRuntimeLogEntries()

/**
 * 操作日志种子：十二条第确定性条目，覆盖安全设置、文件管理、终端会话、日志管理四个分类
 * 与成功/失败两种结果；时间从新到旧排列（与响应口径一致），每条动作与对象照服务端描述符表的措辞。
 * 数据库分类**没有条目**：本期数据库域全是演示，演示动作不写进审计（规格 10.5）。
 */
export const SEED_OPERATION_LOGS: readonly OperationLogEntry[] = [
  { id: '2026-09-23T03:25:10.004Z#12', at: '2026-09-23T03:25:10.004Z', category: 'security', action: '修改 SSH 监听端口', target: 'sshd', summary: '端口 2222', result: 'success', method: 'PUT', path: '/api/security/ssh/port', httpStatus: 200 },
  { id: '2026-09-23T02:41:33.512Z#11', at: '2026-09-23T02:41:33.512Z', category: 'logs', action: '清空运行日志', target: null, summary: '', result: 'success', method: 'POST', path: '/api/logs/runtime/clear', httpStatus: 200 },
  { id: '2026-09-23T01:58:20.187Z#10', at: '2026-09-23T01:58:20.187Z', category: 'files', action: '压缩文件', target: null, summary: 'site', result: 'success', method: 'POST', path: '/api/files/compress', httpStatus: 200 },
  { id: '2026-09-23T00:47:02.930Z#9', at: '2026-09-23T00:47:02.930Z', category: 'security', action: '修改 Root 登录策略', target: 'sshd', summary: '仅允许密钥', result: 'success', method: 'PUT', path: '/api/security/ssh/root-login-policy', httpStatus: 200 },
  { id: '2026-09-22T23:36:41.266Z#8', at: '2026-09-22T23:36:41.266Z', category: 'terminals', action: '打开本机终端会话', target: null, summary: '', result: 'success', method: 'GET', path: '/api/terminals/ws', httpStatus: 200 },
  { id: '2026-09-22T22:19:55.408Z#7', at: '2026-09-22T22:19:55.408Z', category: 'files', action: '复制文件', target: null, summary: 'docs → /srv/backup', result: 'success', method: 'POST', path: '/api/files/copy', httpStatus: 200 },
  { id: '2026-09-22T21:05:12.741Z#6', at: '2026-09-22T21:05:12.741Z', category: 'security', action: '修改系统账号', target: '账号 wangwu', summary: '', result: 'failure', method: 'PUT', path: '/api/security/users/wangwu', httpStatus: 400 },
  { id: '2026-09-22T20:33:07.519Z#5', at: '2026-09-22T20:33:07.519Z', category: 'terminals', action: '打开本机终端会话', target: null, summary: '', result: 'failure', method: 'GET', path: '/api/terminals/ws', httpStatus: 403 },
  { id: '2026-09-22T19:48:30.095Z#4', at: '2026-09-22T19:48:30.095Z', category: 'logs', action: '清空操作日志', target: null, summary: '', result: 'success', method: 'POST', path: '/api/logs/operation/clear', httpStatus: 200 },
  { id: '2026-09-22T18:57:44.830Z#3', at: '2026-09-22T18:57:44.830Z', category: 'files', action: '修改权限', target: null, summary: 'deploy.sh 755 root（递归）', result: 'failure', method: 'POST', path: '/api/files/chmod', httpStatus: 400 },
  { id: '2026-09-22T18:12:26.374Z#2', at: '2026-09-22T18:12:26.374Z', category: 'security', action: '修改 SSH 登录方式', target: 'sshd', summary: '密码登录 开，密钥登录 开', result: 'success', method: 'PUT', path: '/api/security/ssh/auth-methods', httpStatus: 200 },
  { id: '2026-09-22T17:29:58.611Z#1', at: '2026-09-22T17:29:58.611Z', category: 'security', action: '修改防火墙开关', target: null, summary: '防火墙 开，禁 Ping 开', result: 'success', method: 'PUT', path: '/api/security/firewall/toggles', httpStatus: 200 },
]

// 内存态：清空改写这两个数组（清空后数组里只剩本次清空留下的留痕），resetLogsData 恢复种子。
let runtimeLogs: readonly RuntimeLogEntry[] = SEED_RUNTIME_LOGS
let operationLogs: readonly OperationLogEntry[] = SEED_OPERATION_LOGS

/** 当前运行日志条目（倒序，最新在最上）。 */
export function runtimeLogEntries(): readonly RuntimeLogEntry[] {
  return runtimeLogs
}

/** 当前操作日志条目（倒序）。 */
export function operationLogEntries(): readonly OperationLogEntry[] {
  return operationLogs
}

/** 清空一个类别的内存条目；留痕由调用方（清空动作本身）构造后写回。 */
export function replaceRuntimeLogEntries(entries: readonly RuntimeLogEntry[]): void {
  runtimeLogs = entries
}

export function replaceOperationLogEntries(entries: readonly OperationLogEntry[]): void {
  operationLogs = entries
}

/** 两个类别都恢复回种子：演示状态只在内存，刷新即回种子。 */
export function resetLogsData(): void {
  runtimeLogs = SEED_RUNTIME_LOGS
  operationLogs = SEED_OPERATION_LOGS
}

export function getLoginLogs(): readonly LoginLogEntry[] {
  return SEED_LOGIN_LOGS
}
