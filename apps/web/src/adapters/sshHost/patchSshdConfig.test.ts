import { describe, expect, it } from 'vitest'
import { patchSshdConfig } from './patchSshdConfig'

/*
 * sshd_config 补丁器的夹具用例：只动白名单指令行，其余行逐字保留；
 * 追加必须落在全局段内（Match 块之前）。
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

  it('同一指令多次出现只替换首个生效行，后续行原样保留', () => {
    const next = patchSshdConfig('Port 22\nPort 23\n', { Port: '2202' })
    expect(next.split('\n')).toEqual(['Port 2202', 'Port 23', ''])
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
})
