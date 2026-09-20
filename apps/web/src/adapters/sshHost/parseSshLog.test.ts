import { describe, expect, it } from 'vitest'
import { SSH_LOG_TAIL_LINES, parseSshLog, summarizeSshLog, tailLines } from './parseSshLog'

/*
 * sshd 登录日志解析的夹具用例：三类事实行、invalid user 前缀、无年份时间戳的
 * 补全与跨年、行数上限截尾、三窗口统计，以及 sshd -E 直写的无前缀裸行。
 * 基准时间用本地时构造（new Date(年, 月, 日, …)）：解析与窗口统计都以本地时解释，
 * 两者自洽，断言因此在任何机器时区下都得到同一结果。
 */

/** 基准：本地时 2026-09-18 20:00，日志全部落在「今日」。 */
function localIso(year: number, monthIndex: number, day: number, hour = 0, minute = 0, second = 0): string {
  return new Date(year, monthIndex, day, hour, minute, second).toISOString()
}

const NOW = localIso(2026, 8, 18, 20, 0, 0)

/** syslog 守护转发的形态（容器外真实服务器、或编排了 syslog 的环境）。 */
const SYSLOG_LOG = [
  'Sep 18 08:00:01 elysian sshd[101]: Server listening on 0.0.0.0 port 73.', // 无关行跳过
  'Sep 18 08:12:04 elysian sshd[102]: Accepted publickey for root from 1.204.32.143 port 16999 ssh2: ED25519 SHA256:abcd',
  'Sep 18 09:12:05 elysian sshd[103]: Accepted password for ops from 114.139.238.201 port 18569 ssh2',
  'Sep 18 10:12:06 elysian sshd[104]: Failed password for root from 45.155.205.233 port 51422 ssh2',
  'Sep 18 11:12:07 elysian sshd[105]: Failed password for invalid user admin from 45.155.205.233 port 51423 ssh2',
  'Sep 18 12:12:08 elysian sshd[106]: pam_unix(sshd:session): session opened for user root', // 无关行跳过
].join('\n')

/** `sshd -E /var/log/sshd.log` 直写的裸行：无时间戳、无主机与 pid 前缀（容器实际形态）。 */
const BARE_LOG = [
  'Server listening on 0.0.0.0 port 73.', // 无关行跳过
  'Accepted publickey for elysian from ::1 port 41234 ssh2: ED25519 SHA256:abcd',
  'Accepted password for root from 127.0.0.1 port 41235 ssh2',
  'Failed password for invalid user admin from 203.0.113.9 port 41236 ssh2',
  'Connection closed by authenticating user root 203.0.113.9 port 41237 [preauth]', // 无关行跳过
].join('\n')

describe('parseSshLog', () => {
  it('syslog 前缀行：三类登录事实行解析为记录，其余行跳过', () => {
    const lines = parseSshLog(SYSLOG_LOG, NOW)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatchObject({ user: 'root', ip: '1.204.32.143', port: 16999, result: 'succeeded', at: localIso(2026, 8, 18, 8, 12, 4) })
    expect(lines[1]).toMatchObject({ user: 'ops', ip: '114.139.238.201', port: 18569, result: 'succeeded' })
    expect(lines[2]).toMatchObject({ user: 'root', ip: '45.155.205.233', port: 51422, result: 'failed' })
    expect(lines[3]).toMatchObject({ user: 'admin', ip: '45.155.205.233', port: 51423, result: 'failed' })
    expect(lines.every((line) => line.at !== null)).toBe(true)
  })

  it('syslog 前缀行：跨年启发式补全为上一年（基准在一月、日志在十二月）', () => {
    const lines = parseSshLog(
      'Dec 30 23:59:59 elysian sshd[1]: Accepted publickey for root from 1.2.3.4 port 1 ssh2',
      localIso(2027, 0, 2, 0, 0, 0),
    )
    expect(lines[0]!.at).toBe(localIso(2026, 11, 30, 23, 59, 59))
  })

  it('sshd -E 裸行：同样解析出登录事实，at 为 null 交给调用方稳定化', () => {
    const lines = parseSshLog(BARE_LOG, NOW)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ user: 'elysian', ip: '::1', port: 41234, result: 'succeeded', at: null })
    expect(lines[1]).toMatchObject({ user: 'root', ip: '127.0.0.1', port: 41235, result: 'succeeded', at: null })
    expect(lines[2]).toMatchObject({ user: 'admin', ip: '203.0.113.9', port: 41236, result: 'failed', at: null })
    // 原始行保留：调用方用它做「行 → 首次观察时间」的稳定映射键。
    expect(lines[0]!.source).toContain('Accepted publickey for elysian from ::1')
  })

  it('两种形态混在同一份文件里都能解析', () => {
    const lines = parseSshLog(`${SYSLOG_LOG}\n${BARE_LOG}`, NOW)
    // syslog 4 条 + 裸行 3 条。
    expect(lines).toHaveLength(7)
    expect(lines.filter((line) => line.at !== null)).toHaveLength(4)
    expect(lines.filter((line) => line.at === null)).toHaveLength(3)
  })

  it('只保留文件尾最近段（SSH_LOG_TAIL_LINES 上限）', () => {
    expect(tailLines(['a', 'b', 'c'].join('\n'), 2)).toBe('b\nc')
    expect(tailLines('a\nb', 0)).toBe('')
    expect(SSH_LOG_TAIL_LINES).toBeGreaterThan(0)
    // 超上限的旧行不再进入解析结果。
    const many = Array.from({ length: SSH_LOG_TAIL_LINES + 5 }, (_, index) =>
      `Sep 18 00:00:00 h sshd[${index}]: Failed password for u from 1.1.1.1 port ${index} ssh2`,
    ).join('\n')
    expect(parseSshLog(many, NOW)).toHaveLength(SSH_LOG_TAIL_LINES)
  })
})

describe('summarizeSshLog', () => {
  /**
   * 基准：本地时 2026-09-18 23:30。
   * 今日（本地时 9-18）2 条（1 成 1 败）、昨日（9-17）1 败、9-10 的 1 成出 7 天窗
   * （窗口 = 今日往前推 7 个自然日，即 9-12 起算）。
   */
  const records = parseSshLog(
    [
      'Sep 18 10:00:00 h sshd[1]: Accepted publickey for u from 1.1.1.1 port 1 ssh2',
      'Sep 18 11:00:00 h sshd[2]: Failed password for u from 1.1.1.1 port 2 ssh2',
      'Sep 17 23:00:00 h sshd[3]: Failed password for u from 1.1.1.1 port 3 ssh2',
      'Sep 10 12:00:00 h sshd[4]: Accepted password for u from 1.1.1.1 port 4 ssh2',
    ].join('\n'),
    localIso(2026, 8, 18, 23, 30, 0),
  ).map((line, index) => ({
    id: `login-${index + 1}`,
    ip: line.ip,
    port: line.port,
    at: line.at ?? localIso(2026, 8, 18, 23, 30, 0),
    user: line.user,
    result: line.result,
  }))

  it('三窗口各自计数，近 7 天包含今日与昨日', () => {
    expect(summarizeSshLog(records, localIso(2026, 8, 18, 23, 30, 0))).toEqual({
      today: { succeeded: 1, failed: 1 },
      yesterday: { succeeded: 0, failed: 1 },
      last7Days: { succeeded: 1, failed: 2 },
    })
  })

  it('窗口边界由注入的基准时间决定：换一天结果不同', () => {
    const nextDay = summarizeSshLog(records, localIso(2026, 8, 19, 0, 30, 0))
    expect(nextDay.today).toEqual({ succeeded: 0, failed: 0 })
    expect(nextDay.yesterday).toEqual({ succeeded: 1, failed: 1 })
    expect(nextDay.last7Days).toEqual({ succeeded: 1, failed: 2 })
  })

  it('基准时间之后的记录（时钟回拨样例）不计入任何窗口', () => {
    const stats = summarizeSshLog(
      [{ ...records[0]!, at: localIso(2026, 8, 18, 23, 31, 0) }],
      localIso(2026, 8, 18, 23, 30, 0),
    )
    expect(stats.today).toEqual({ succeeded: 0, failed: 0 })
  })
})
