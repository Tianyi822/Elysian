import { describe, expect, it } from 'vitest'
import { SSH_LOG_TAIL_LINES, parseSshLog, summarizeSshLog, tailLines } from './parseSshLog'

/*
 * sshd 登录日志解析的夹具用例：三类事实行、invalid user 前缀、无年份时间戳的
 * 补全与跨年、行数上限截尾、三窗口统计。
 * 基准时间用本地时构造（new Date(年, 月, 日, …)）：解析与窗口统计都以本地时解释，
 * 两者自洽，断言因此在任何机器时区下都得到同一结果。
 */

/** 基准：本地时 2026-09-18 20:00，日志全部落在「今日」。 */
function localIso(year: number, monthIndex: number, day: number, hour = 0, minute = 0, second = 0): string {
  return new Date(year, monthIndex, day, hour, minute, second).toISOString()
}

const NOW = localIso(2026, 8, 18, 20, 0, 0)

const LOG_FIXTURE = [
  'Sep 18 08:00:01 elysian sshd[101]: Server listening on 0.0.0.0 port 73.', // 无关行跳过
  'Sep 18 08:12:04 elysian sshd[102]: Accepted publickey for root from 1.204.32.143 port 16999 ssh2: ED25519 SHA256:abcd',
  'Sep 18 09:12:05 elysian sshd[103]: Accepted password for ops from 114.139.238.201 port 18569 ssh2',
  'Sep 18 10:12:06 elysian sshd[104]: Failed password for root from 45.155.205.233 port 51422 ssh2',
  'Sep 18 11:12:07 elysian sshd[105]: Failed password for invalid user admin from 45.155.205.233 port 51423 ssh2',
  'Sep 18 12:12:08 elysian sshd[106]: pam_unix(sshd:session): session opened for user root', // 无关行跳过
].join('\n')

describe('parseSshLog', () => {
  it('三类登录事实行解析为记录，其余行跳过', () => {
    const records = parseSshLog(LOG_FIXTURE, NOW)
    expect(records).toHaveLength(4)
    expect(records[0]).toMatchObject({ user: 'root', ip: '1.204.32.143', port: 16999, result: 'succeeded' })
    expect(records[1]).toMatchObject({ user: 'ops', ip: '114.139.238.201', port: 18569, result: 'succeeded' })
    expect(records[2]).toMatchObject({ user: 'root', ip: '45.155.205.233', port: 51422, result: 'failed' })
    expect(records[3]).toMatchObject({ user: 'admin', ip: '45.155.205.233', port: 51423, result: 'failed' })
  })

  it('id 按输出序编号且时间补全为 ISO（本地时解释）', () => {
    const records = parseSshLog(LOG_FIXTURE, NOW)
    expect(records.map((record) => record.id)).toEqual(['login-1', 'login-2', 'login-3', 'login-4'])
    expect(records[0]!.at).toBe(localIso(2026, 8, 18, 8, 12, 4))
  })

  it('跨年启发式：基准在一月、日志在十二月时补全为上一年', () => {
    const records = parseSshLog(
      'Dec 30 23:59:59 elysian sshd[1]: Accepted publickey for root from 1.2.3.4 port 1 ssh2',
      localIso(2027, 0, 2, 0, 0, 0),
    )
    expect(records[0]!.at).toBe(localIso(2026, 11, 30, 23, 59, 59))
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
  )

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
