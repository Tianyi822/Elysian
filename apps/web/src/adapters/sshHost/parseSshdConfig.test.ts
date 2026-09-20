import { describe, expect, it } from 'vitest'
import { parseSshdConfig, stripConfigComment } from './parseSshdConfig'

/*
 * sshd_config 解析器的夹具用例：注释、行内注释、大小写、多次出现、Match 块。
 * 样本覆盖面板在真实容器里会遇到的 /etc/ssh/sshd_config 形态。
 */

const FULL_FIXTURE = [
  '# 这是 Debian 系出厂常见的形态',
  'Port 73',
  '',
  'PasswordAuthentication no',
  'PubkeyAuthentication yes',
  'PermitRootLogin prohibit-password',
  'X11Forwarding yes',
  'Include /etc/ssh/sshd_config.d/*.conf',
].join('\n')

describe('parseSshdConfig', () => {
  it('读取四个白名单指令的取值', () => {
    expect(parseSshdConfig(FULL_FIXTURE)).toEqual({
      port: 73,
      passwordAuthentication: false,
      pubkeyAuthentication: true,
      permitRootLogin: 'prohibit-password',
    })
  })

  it('指令缺省时全部为 null，由调用方按 sshd 默认值兜底', () => {
    expect(parseSshdConfig('# 只有注释\nX11Forwarding yes\n')).toEqual({
      port: null,
      passwordAuthentication: null,
      pubkeyAuthentication: null,
      permitRootLogin: null,
    })
  })

  it('注释行整行跳过，注释里的指令不生效', () => {
    const directives = parseSshdConfig('# Port 2222\n#PasswordAuthentication yes\nPort 22\n')
    expect(directives.port).toBe(22)
    expect(directives.passwordAuthentication).toBeNull()
  })

  it('行内注释剥离后再取值', () => {
    const directives = parseSshdConfig('Port 2222 # 迁移后的新端口\nPermitRootLogin no # 收紧\n')
    expect(directives.port).toBe(2222)
    expect(directives.permitRootLogin).toBe('no')
  })

  it('指令名与 yes/no 取值都大小写不敏感', () => {
    const directives = parseSshdConfig('port 2202\nPASSWORDAUTHENTICATION YES\npubkeyauthentication NO\npermitrootlogin YES')
    expect(directives).toEqual({
      port: 2202,
      passwordAuthentication: true,
      pubkeyAuthentication: false,
      permitRootLogin: 'yes',
    })
  })

  it('同一指令多次出现取首个生效值（sshd first-obtained 语义）', () => {
    const directives = parseSshdConfig('Port 2202\nPort 2203\nPermitRootLogin no\nPermitRootLogin yes\n')
    expect(directives.port).toBe(2202)
    expect(directives.permitRootLogin).toBe('no')
  })

  it('Match 块内的指令不进全局取值', () => {
    const directives = parseSshdConfig([
      'Port 22',
      'PasswordAuthentication no',
      'Match User deploy',
      '  PasswordAuthentication yes',
      '  Port 2222',
      'Match Address 10.0.0.0/8',
      '  PermitRootLogin yes',
    ].join('\n'))
    expect(directives).toEqual({
      port: 22,
      passwordAuthentication: false,
      pubkeyAuthentication: null,
      permitRootLogin: null,
    })
  })

  it('取值无法辨认时置 null：端口越界、开关值未知', () => {
    const directives = parseSshdConfig('Port 70000\nPasswordAuthentication maybe\n')
    expect(directives.port).toBeNull()
    expect(directives.passwordAuthentication).toBeNull()
  })

  it('CRLF 行尾同样可解析', () => {
    const directives = parseSshdConfig('Port 73\r\nPasswordAuthentication no\r\n')
    expect(directives.port).toBe(73)
    expect(directives.passwordAuthentication).toBe(false)
  })
})

describe('stripConfigComment', () => {
  it('井号在行首或空白之后才算注释', () => {
    expect(stripConfigComment('# Port 22')).toBe('')
    expect(stripConfigComment('  # Port 22')).toBe('')
    expect(stripConfigComment('Port 22 # 备注')).toBe('Port 22')
    expect(stripConfigComment('Port22#x')).toBe('Port22#x')
  })
})
