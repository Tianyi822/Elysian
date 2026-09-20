import type { SshLoginRecord, SshLoginResult, SshLoginStats, SshLoginCounts } from '@elysian/contracts'

/*
 * /var/log/sshd.log 的解析器：只认三类登录事实行——Accepted publickey、
 * Accepted password、Failed password，其余行（会话开关、子系统、压缩日志等）跳过。
 *
 * 两种行形态都吃：
 * - syslog 守护转发的行带 `Sep 20 08:12:04 host sshd[123]:` 前缀，时间戳（无年份）
 *   按注入的基准时间补全（月份大于基准月份视为跨年，取上一年）。
 * - 容器以 `sshd -E /var/log/sshd.log` 直写的行没有任何前缀（裸消息文本），
 *   这类行没有时间戳：at 置 null，由调用方用「行 → 首次观察到的时间」稳定化，
 *   不能每次读取都打上当前时刻——那会把历史失败记录全部漂进今日窗口。
 */

/** 读取登录日志的行数上限：只取文件尾的最近段，防日志膨胀拖垮读取与解析。 */
export const SSH_LOG_TAIL_LINES = 2000

/** 解析出的一条登录事实；at 仅 syslog 前缀行有，裸行为 null。 */
export type ParsedLoginLine = {
  /** 原始日志行（trim 后）：无时间戳行的稳定时间映射键。 */
  source: string
  user: string
  ip: string
  port: number
  result: SshLoginResult
  at: string | null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Sep 20 08:12:04 host sshd[123]:` syslog 前缀；捕获组 1-5 为时间、组 6 为消息正文。 */
const SYSLOG_PREFIX_RE = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+\S+\s+sshd\[\d+\]:\s+(.*)$/

/** 登录事实消息正文：`Accepted publickey for root from 1.2.3.4 port 51234 ssh2 …`。 */
const LOGIN_MESSAGE_RE =
  /^(Accepted\s+(?:publickey|password)|Failed\s+password)\s+for\s+(?:invalid\s+user\s+)?(\S+)\s+from\s+(\S+)\s+port\s+(\d+)/

/** 只保留文件尾最近 limit 行；limit 非正时返回空文本。 */
export function tailLines(text: string, limit: number): string {
  if (limit <= 0) return ''
  const lines = text.split('\n')
  return lines.slice(Math.max(0, lines.length - limit)).join('\n')
}

/** 解析日志全文（先按 SSH_LOG_TAIL_LINES 截尾），按日志书写顺序返回。 */
export function parseSshLog(text: string, nowIso: string): readonly ParsedLoginLine[] {
  const now = new Date(nowIso)
  const parsed: ParsedLoginLine[] = []
  const lines = tailLines(text, SSH_LOG_TAIL_LINES).split('\n')

  for (const rawLine of lines) {
    const source = rawLine.trim()
    if (!source) continue
    // 先剥 syslog 前缀（有则取消息正文与时间），没有前缀则整行就是消息正文（sshd -E 裸行）。
    const prefixed = SYSLOG_PREFIX_RE.exec(source)
    const message = prefixed ? prefixed[6] : source
    const match = LOGIN_MESSAGE_RE.exec(message ?? '')
    if (!match) continue
    const [, eventText, user, ip, portText] = match

    let at: string | null = null
    if (prefixed) {
      const [, monthText, dayText, hourText, minuteText, secondText] = prefixed
      const month = MONTHS.indexOf(monthText ?? '')
      const day = Number.parseInt(dayText ?? '', 10)
      if (month < 0 || !Number.isInteger(day)) continue
      // 跨年启发式：syslog 无年份，月份「超前」于基准时间说明这条属于上一年（12 月的日志滚到 1 月还在写）。
      let year = now.getFullYear()
      if (month > now.getMonth()) year -= 1
      at = new Date(
        year,
        month,
        day,
        Number.parseInt(hourText ?? '0', 10),
        Number.parseInt(minuteText ?? '0', 10),
        Number.parseInt(secondText ?? '0', 10),
      ).toISOString()
    }

    parsed.push({
      source,
      user: user ?? '',
      ip: ip ?? '',
      port: Number.parseInt(portText ?? '0', 10),
      result: eventText?.startsWith('Accepted') ? 'succeeded' : 'failed',
      at,
    })
  }

  return parsed
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
