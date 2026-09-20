import { describe, expect, it } from 'vitest'
import { patchSshdConfig } from './patchSshdConfig'

/*
 * sshd_config 补丁器的夹具用例：只动白名单指令行，其余行逐字保留；
 * 追加必须落在全局段内且先于任何 Include 与 Match（Port 的累积语义单独覆盖）。
 */

const BASE = ['# 全局段', 'Port 22', 'X11Forwarding yes', 'PermitRootLogin yes'].join('\n')

describe('patchSshdConfig', () => {
  it('已有指令整行替换为规范写法，其余行逐字不动', () => {
    const next = patchSshdConfig(`${BASE}\n`, { Port: '2202', PermitRootLogin: 'no' })
    expect(next.split('\n')).toEqual(['# 全局段', 'Port 2202', 'X11Forwarding yes', 'PermitRootLogin no', ''])
  })

  it('指令名按大小写不敏感匹配替换，行内注释与缩进被规范写法取代', () => {
    const next = patchSshdConfig('passwordAuthentication yes   # 开启\n', { PasswordAuthentication: 'no' })
    expect(next.split('\n')).toEqual(['PasswordAuthentication no', ''])
  })

  it('Port 为累积监听指令：首个替换，其余未注释 Port 行注释掉，旧端口不再监听', () => {
    const next = patchSshdConfig('Port 22\nPort 23\nPort 24\n', { Port: '2202' })
    expect(next.split('\n')).toEqual(['Port 2202', '#Port 23', '#Port 24', ''])
  })

  it('非 Port 指令多次出现只替换首个生效行，后续行原样保留', () => {
    const next = patchSshdConfig('PermitRootLogin no\nPermitRootLogin yes\n', { PermitRootLogin: 'yes' })
    expect(next.split('\n')).toEqual(['PermitRootLogin yes', 'PermitRootLogin yes', ''])
  })

  it('缺省指令追加到文件尾并保留结尾换行', () => {
    const next = patchSshdConfig('Port 22\n', { PubkeyAuthentication: 'yes' })
    expect(next).toBe('Port 22\nPubkeyAuthentication yes\n')
  })

  it('文件没有结尾换行时追加同样得到完整行', () => {
    const next = patchSshdConfig('Port 22', { PubkeyAuthentication: 'no' })
    expect(next).toBe('Port 22\nPubkeyAuthentication no')
  })

  it('带 Match 块时追加到首个 Match 之前，不落进条件块', () => {
    const text = ['Port 22', 'Match User deploy', '  PasswordAuthentication yes'].join('\n')
    const next = patchSshdConfig(text, { PasswordAuthentication: 'no' })
    expect(next.split('\n')).toEqual(['Port 22', 'PasswordAuthentication no', 'Match User deploy', '  PasswordAuthentication yes'])
  })

  it('带 Match 块时对已有全局指令仍是行内替换，Match 块不动', () => {
    const text = ['Port 22', 'Match User deploy', '  Port 2222'].join('\n')
    const next = patchSshdConfig(text, { Port: '2202' })
    expect(next.split('\n')).toEqual(['Port 2202', 'Match User deploy', '  Port 2222'])
  })

  it('注释掉的指令不视为已有取值，走追加而不是改注释', () => {
    const next = patchSshdConfig('#Port 22\n', { Port: '2202' })
    expect(next.split('\n')).toEqual(['#Port 22', 'Port 2202', ''])
  })

  it('一次补丁多个指令，追加顺序与白名单顺序一致', () => {
    const next = patchSshdConfig('', {
      PermitRootLogin: 'no',
      Port: '2202',
      PasswordAuthentication: 'no',
      PubkeyAuthentication: 'yes',
    })
    expect(next.split('\n')).toEqual(['Port 2202', 'PasswordAuthentication no', 'PubkeyAuthentication yes', 'PermitRootLogin no', ''])
  })

  it('空补丁输出与输入逐字相同（白名单外零改动）', () => {
    const text = 'Port 22\nInclude /etc/ssh/sshd_config.d/*.conf\n# 备注\n'
    expect(patchSshdConfig(text, {})).toBe(text)
  })

  it('追加行插到 Include 之前：first-obtained 语义下不被 sshd_config.d 遮蔽', () => {
    const text = ['# Ubuntu 出厂形态', 'Include /etc/ssh/sshd_config.d/*.conf', '#Port 22', ''].join('\n')
    const next = patchSshdConfig(text, { Port: '2202' })
    expect(next.split('\n')).toEqual([
      '# Ubuntu 出厂形态',
      'Port 2202',
      'Include /etc/ssh/sshd_config.d/*.conf',
      '#Port 22',
      '',
    ])
  })

  it('Include 之后的同指令行不作替换目标，面板行插到 Include 之前接管生效', () => {
    const text = ['Include /etc/ssh/sshd_config.d/*.conf', 'PasswordAuthentication yes', ''].join('\n')
    const next = patchSshdConfig(text, { PasswordAuthentication: 'no' })
    expect(next.split('\n')).toEqual([
      'PasswordAuthentication no',
      'Include /etc/ssh/sshd_config.d/*.conf',
      'PasswordAuthentication yes',
      '',
    ])
  })

  it('Include 与 Match 并存时插入点取更早者；Include 之前的已有指令仍整行替换', () => {
    const text = ['Port 22', 'Include /etc/ssh/sshd_config.d/*.conf', 'Match User deploy', '  PermitRootLogin yes'].join('\n')
    const next = patchSshdConfig(text, { PermitRootLogin: 'no' })
    expect(next.split('\n')).toEqual([
      'Port 22',
      'PermitRootLogin no',
      'Include /etc/ssh/sshd_config.d/*.conf',
      'Match User deploy',
      '  PermitRootLogin yes',
    ])
  })

  it('指令的等号写法同样被识别为已有取值：整行替换，旧 Port 不留行继续监听', () => {
    // 漏识别时面板会追加一行新 Port 并保留 Port=22：Port 是累积监听指令，
    // sshd 会同时监听新旧端口，而面板只显示新端口。
    const next = patchSshdConfig('Port=22\nPasswordAuthentication=yes\n', {
      Port: '2202',
      PasswordAuthentication: 'no',
    })
    expect(next.split('\n')).toEqual(['Port 2202', 'PasswordAuthentication no', ''])
  })

  it('Include 的等号写法同样识别：面板行仍插到 Include 之前', () => {
    // sshd_config(5)：关键词与取值可用「可选空白 + 恰一个 = + 可选空白」分隔。
    // 漏识别时插入点落到文件尾，面板行会被 drop-in 按 first-obtained 遮蔽。
    const text = ['Include=/etc/ssh/sshd_config.d/*.conf', '#Port 22', ''].join('\n')
    const next = patchSshdConfig(text, { Port: '2202' })
    expect(next.split('\n')).toEqual(['Port 2202', 'Include=/etc/ssh/sshd_config.d/*.conf', '#Port 22', ''])
  })

  it('Match 的等号写法同样识别：面板行插到块前，块内 Port 行不被注释', () => {
    const text = ['Port 22', 'Match=User deploy', '  Port 2222'].join('\n')
    const next = patchSshdConfig(text, { Port: '2202' })
    expect(next.split('\n')).toEqual(['Port 2202', 'Match=User deploy', '  Port 2222'])
  })

  it('Include 之后的未注释 Port 行同样被替换或注释（累积指令不受取值顺序保护）', () => {
    const text = ['Include /etc/ssh/sshd_config.d/*.conf', 'Port 22', 'Port 23', ''].join('\n')
    const next = patchSshdConfig(text, { Port: '2202' })
    expect(next.split('\n')).toEqual(['Include /etc/ssh/sshd_config.d/*.conf', 'Port 2202', '#Port 23', ''])
  })
})
