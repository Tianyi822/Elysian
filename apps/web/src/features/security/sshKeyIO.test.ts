import { describe, expect, it } from 'vitest'
import { buildKeyFilename } from './sshKeyIO'

describe('密钥导出文件名', () => {
  it('无密钥名称时以归属账号开头，带生成日期与 pem 扩展名，不用平台名', () => {
    expect(buildKeyFilename('root', '2026-09-20T07:54:23.724Z')).toBe('root-ssh-key-20260920.pem')
    expect(buildKeyFilename('wangwu', '2026-01-02T23:59:59.999Z')).toBe('wangwu-ssh-key-20260102.pem')
  })

  it('登录密钥带上创建时填写的名称：账号名在前、密钥名紧随其后', () => {
    expect(buildKeyFilename('elysian', '2026-09-21T04:00:00.000Z', 'deploy')).toBe(
      'elysian-deploy-ssh-key-20260921.pem',
    )
    // 中文名原样进文件名：密钥名是用户识别这把钥匙的第一线索，不做转写。
    expect(buildKeyFilename('elysian', '2026-09-21T04:00:00.000Z', '部署机')).toBe(
      'elysian-部署机-ssh-key-20260921.pem',
    )
  })

  it('密钥名里的路径分隔符与控制字符替换为连字符：名称校验只看非空与长度，文件名必须安全', () => {
    expect(buildKeyFilename('elysian', '2026-09-21T04:00:00.000Z', ' a/b\\c ')).toBe(
      'elysian-a-b-c-ssh-key-20260921.pem',
    )
  })
})
