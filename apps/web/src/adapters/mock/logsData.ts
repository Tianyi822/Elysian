import type { LoginLogEntry, RuntimeLogSnapshot } from '@elysian/contracts'

/*
 * 日志演示数据集。登录记录是手工固定的种子行（IP、归属地与 User-Agent 取自真实样例），
 * 运行日志按固定模板与固定步长生成，两者都确定性可复现；
 * 日志是只读事实，不提供任何变更动作，因此也不需要 reset。
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

/** 固定的日志行模板：按索引取行，DEBUG/INFO/WARNING/ERROR 穿插，不引入随机数。 */
const RUNTIME_LOG_TEMPLATES: readonly string[] = [
  '[DEBUG] panelModel/publicModel.py:get_announcement_list:604 轮询公告列表',
  '[DEBUG] ajax.py:get_load_average:652 采集负载均值 load1=0.14 load5=0.22',
  '[INFO] system.py:collect_metrics:112 采集完成 cpu=6.2% mem=41.5% disk=63.8%',
  '[INFO] ssl.py:check_expire:203 证书 demo.elysian.local 距到期还有 21 天',
  '[DEBUG] files.py:scan_delta:88 增量扫描完成 变更 0 个文件',
  '[INFO] backup.py:run_night_backup:421 凌晨备份校验通过 备份集 3 个',
  '[WARNING] mariadb.py:slow_query_watch:156 检测到 2 条慢查询 最高 1.8s',
  '[DEBUG] public.py:heartbeat:57 心跳正常 在线会话 2 个',
  '[ERROR] smtp.py:notify_admin:312 告警邮件发送失败 SMTP 535，转下个重试窗口',
  '[INFO] docker.py:stats_poll:201 容器统计已刷新 7 个运行中',
]

/** 固定起点按分钟推进生成 240 行（十几 KB，与参照产品同量级），时间戳用 UTC 书写保证确定性。 */
function buildRuntimeLogContent(): string {
  const start = Date.parse('2026-09-16T11:24:54Z')
  const lines: string[] = []
  for (let index = 0; index < 240; index += 1) {
    const stamp = new Date(start + index * 60_000).toISOString().slice(0, 19).replace('T', ' ')
    lines.push(`${stamp} ${RUNTIME_LOG_TEMPLATES[index % RUNTIME_LOG_TEMPLATES.length]}`)
  }
  return `${lines.join('\n')}\n`
}

export function getRuntimeLog(): RuntimeLogSnapshot {
  const content = buildRuntimeLogContent()
  return { content, sizeBytes: new TextEncoder().encode(content).length }
}

export function getLoginLogs(): readonly LoginLogEntry[] {
  return SEED_LOGIN_LOGS
}
