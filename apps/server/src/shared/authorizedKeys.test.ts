import { describe, expect, it } from 'vitest'
import {
  algorithmLabelOf,
  appendKeyLine,
  authorizedKeyId,
  authorizedKeysPath,
  keyCommentOf,
  keyLineId,
  listKeyAccounts,
  parseGetentPasswd,
  parseKeygenFingerprint,
  parseKeyLines,
  removeKeyLine,
  replaceFirstKeyLine,
  sshDirPath,
} from './authorizedKeys'

/*
 * authorized_keys 行级编辑与账号定位的夹具用例。
 * passwd 样本取 Debian 系常见形态；公钥行用占位 base64（解析只看形状，不解码）。
 */

const KEY_OPS = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOPS占位 ops@example'
const KEY_CI = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICI占位 ci@example'

const PASSWD_FIXTURE = [
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'ops:x:1000:1000:Ops,,:/home/ops:/bin/bash',
  'deploy:x:1001:1001::/home/deploy:/bin/false',
  'svc:x:999:999::/home/svc:/usr/sbin/nologin',
  'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
  '这行不是 passwd',
].join('\n')

describe('getent passwd 解析与账号清单', () => {
  it('逐行解析，无法辨认的行跳过', () => {
    const entries = parseGetentPasswd(PASSWD_FIXTURE)
    expect(entries.map((entry) => entry.name)).toEqual(['root', 'daemon', 'ops', 'deploy', 'svc', 'nobody'])
    expect(entries[2]).toEqual({ name: 'ops', uid: 1000, gid: 1000, home: '/home/ops', shell: '/bin/bash' })
  })

  it('密钥归属账号：uid≥1000 且有登录 shell，root 与系统账号都不列', () => {
    expect(listKeyAccounts(PASSWD_FIXTURE)).toEqual([{ id: 'ops', name: 'ops' }])
  })
})

describe('路径推导', () => {
  it('主目录尾斜杠被归一，.ssh 与 authorized_keys 路径只由服务端拼接', () => {
    expect(sshDirPath('/home/ops')).toBe('/home/ops/.ssh')
    expect(sshDirPath('/home/ops/')).toBe('/home/ops/.ssh')
    expect(authorizedKeysPath('/root')).toBe('/root/.ssh/authorized_keys')
  })
})

describe('authorized_keys 行级操作', () => {
  it('读出有效公钥行：空行与注释行不算', () => {
    const text = [`# 运维备注`, KEY_OPS, '', KEY_CI, '   '].join('\n')
    expect(parseKeyLines(text)).toEqual([KEY_OPS, KEY_CI])
  })

  it('追加保证独立成行：空文件、无结尾换行、有结尾换行三种输入', () => {
    expect(appendKeyLine('', KEY_OPS)).toBe(`${KEY_OPS}\n`)
    expect(appendKeyLine(KEY_OPS, KEY_CI)).toBe(`${KEY_OPS}\n${KEY_CI}\n`)
    expect(appendKeyLine(`${KEY_OPS}\n`, KEY_CI)).toBe(`${KEY_OPS}\n${KEY_CI}\n`)
    expect(appendKeyLine(`${KEY_OPS}\n\n\n`, KEY_CI)).toBe(`${KEY_OPS}\n${KEY_CI}\n`)
  })

  it('按整行精确匹配移除；行不存在时原样返回', () => {
    const text = `${KEY_OPS}\n${KEY_CI}\n`
    expect(removeKeyLine(text, KEY_OPS)).toBe(`${KEY_CI}\n`)
    expect(removeKeyLine(text, 'ssh-ed25519 对不上')).toBe(text)
  })

  it('替换首条公钥行：其余行与注释行原样保留；还没有公钥行时整文件只剩新行', () => {
    const NEW_ROOT = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIROOT新 root@elysian'
    // 有旧公钥：首行被替换，第二把外来公钥保留。
    expect(replaceFirstKeyLine(`${KEY_OPS}\n${KEY_CI}\n`, NEW_ROOT)).toBe(`${NEW_ROOT}\n${KEY_CI}\n`)
    // 注释与空行不算公钥行：替换发生在第一条真正的公钥上。
    expect(replaceFirstKeyLine(`# 手工维护\n\n${KEY_OPS}\n`, NEW_ROOT)).toBe(
      `# 手工维护\n\n${NEW_ROOT}\n`,
    )
    // 没有任何公钥行（含纯注释文件）：整文件只剩新行。
    expect(replaceFirstKeyLine('', NEW_ROOT)).toBe(`${NEW_ROOT}\n`)
    expect(replaceFirstKeyLine('# 只有注释\n', NEW_ROOT)).toBe(`${NEW_ROOT}\n`)
  })

  it('公钥行的 id 跨读取稳定且对内容敏感', () => {
    expect(keyLineId(KEY_OPS)).toBe(keyLineId(KEY_OPS))
    expect(keyLineId(KEY_OPS)).not.toBe(keyLineId(KEY_CI))
    expect(keyLineId(KEY_OPS)).toMatch(/^sshkey-[0-9a-f]{8}$/)
  })

  it('账号维度的授权行 id：同账号同内容稳定，同一公钥行跨账号 id 不同', () => {
    expect(authorizedKeyId('ops', KEY_OPS)).toBe(authorizedKeyId('ops', KEY_OPS))
    expect(authorizedKeyId('ops', KEY_OPS)).not.toBe(authorizedKeyId('dev', KEY_OPS))
    expect(authorizedKeyId('ops', KEY_OPS)).toMatch(/^sshkey-[0-9a-f]{8}$/)
  })

  it('注释段作为密钥名的来源', () => {
    expect(keyCommentOf(KEY_OPS)).toBe('ops@example')
    expect(keyCommentOf('ssh-ed25519 AAAA无注释')).toBe('')
  })
})

describe('ssh-keygen -lf 输出解析', () => {
  it('解析位数、指纹、注释与算法短名', () => {
    const parsed = parseKeygenFingerprint('256 SHA256:abc123456 elysian-部署机 (ED25519)\n')
    expect(parsed).toEqual({
      bits: 256,
      fingerprint: 'SHA256:abc123456',
      comment: 'elysian-部署机',
      typeToken: 'ED25519',
    })
  })

  it('算法呈现文本：已知短名映射为公钥类型名，未知短名原样保留', () => {
    expect(algorithmLabelOf({ bits: 256, fingerprint: '', comment: '', typeToken: 'ED25519' })).toBe('ssh-ed25519 256')
    expect(algorithmLabelOf({ bits: 3072, fingerprint: '', comment: '', typeToken: 'RSA' })).toBe('ssh-rsa 3072')
    expect(algorithmLabelOf({ bits: 256, fingerprint: '', comment: '', typeToken: 'SOMETHING' })).toBe('SOMETHING 256')
  })

  it('形状不对返回 null', () => {
    expect(parseKeygenFingerprint('')).toBeNull()
    expect(parseKeygenFingerprint('不是指纹输出')).toBeNull()
  })
})
