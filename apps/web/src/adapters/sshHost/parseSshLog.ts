import type { SshLoginCounts, SshLoginRecord, SshLoginStats } from '@elysian/contracts'

/*
 * /var/log/sshd.log 的解析器：只认三类登录事实行——Accepted publickey、
 * Accepted password、Failed password，其余行（会话开关、子系统、压缩日志等）跳过。
 * syslog 时间戳不带年份：按注入的基准时间补全年份（月份大于基准月份视为跨年，
 * 取上一年），解析与窗口统计都用本地时区，两者自洽。
 */

/** 读取登录日志的行数上限：只取文件尾的最近段，防日志膨胀拖垮读取与解析。 */
export const SSH_LOG_TAIL_LINES = 2000

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 形如 `Sep 20 08:12:04 host sshd[123]: Accepted publickey for root from 1.2.3.4 port 51234 ssh2 …`。 */
const LOGIN_LINE_RE =
  /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+\S+\s+sshd\[\d+\]:\s+(Accepted\s+(?:publickey|password)|Failed\s+password)\s+for\s+(?:invalid\s+user\s+)?(\S+)\s+from\s+(\S+)\s+port\s+(\d+)/

/** 只保留文件尾最近 limit 行；limit 非正时返回空文本。 */
export function tailLines(text: string, limit: number): string {
  if (limit <= 0) return ''
  const lines = text.split('\n')
  return lines.slice(Math.max(0, lines.length - limit)).join('\n')
}

/** 解析日志全文（先按 SSH_LOG_TAIL_LINES 截尾），按日志时间顺序返回；id 按输出序编号，确定性可复现。 */
export function parseSshLog(text: string, nowIso: string): readonly SshLoginRecord[] {
  const now = new Date(nowIso)
  const records: SshLoginRecord[] = []
  const lines = tailLines(text, SSH_LOG_TAIL_LINES).split('\n')

  for (const line of lines) {
    const match = LOGIN_LINE_RE.exec(line)
    if (!match) continue
    const [, monthText, dayText, hourText, minuteText, secondText, eventText, user, ip, portText] = match
    const month = MONTHS.indexOf(monthText ?? '')
    const day = Number.parseInt(dayText ?? '', 10)
    if (month < 0 || !Number.isInteger(day)) continue

    // 跨年启发式：syslog 无年份，月份「超前」于基准时间说明这条属于上一年（12 月的日志滚到 1 月还在写）。
    let year = now.getFullYear()
    if (month > now.getMonth()) year -= 1
    const at = new Date(
      year,
      month,
      day,
      Number.parseInt(hourText ?? '0', 10),
      Number.parseInt(minuteText ?? '0', 10),
      Number.parseInt(secondText ?? '0', 10),
    ).toISOString()

    records.push({
      id: `login-${records.length + 1}`,
      ip: ip ?? '',
      port: Number.parseInt(portText ?? '0', 10),
      at,
      user: user ?? '',
      result: eventText?.startsWith('Accepted') ? 'succeeded' : 'failed',
    })
  }

  return records
}

/** 本地时的当日零点。 */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** 三窗口统计：今日、昨日、近 7 天（含今日往前推 7 个自然日）；窗口边界由注入的基准时间决定。 */
export function summarizeSshLog(records: readonly SshLoginRecord[], nowIso: string): SshLoginStats {
  const now = new Date(nowIso)
  const todayStart = startOfDay(now).getTime()
  const yesterdayStart = todayStart - 24 * 60 * 60_000
  const weekStart = todayStart - 6 * 24 * 60 * 60_000
  const stats: SshLoginStats = {
    today: zeroCounts(),
    yesterday: zeroCounts(),
    last7Days: zeroCounts(),
  }

  for (const record of records) {
    const at = new Date(record.at).getTime()
    if (at > now.getTime()) continue
    const result = record.result === 'succeeded' ? 'succeeded' : 'failed'
    if (at >= todayStart) {
      count(stats.today, result)
      count(stats.last7Days, result)
    } else if (at >= yesterdayStart) {
      count(stats.yesterday, result)
      count(stats.last7Days, result)
    } else if (at >= weekStart) {
      count(stats.last7Days, result)
    }
  }

  return stats
}

function zeroCounts(): SshLoginCounts {
  return { succeeded: 0, failed: 0 }
}

function count(target: SshLoginCounts, result: 'succeeded' | 'failed'): void {
  target[result] += 1
}
