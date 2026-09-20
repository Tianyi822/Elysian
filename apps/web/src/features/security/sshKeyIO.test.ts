import { describe, expect, it } from 'vitest'
import { buildKeyFilename } from './sshKeyIO'

describe('密钥导出文件名', () => {
  it('以归属账号开头，带生成日期与 pem 扩展名，不用平台名', () => {
    expect(buildKeyFilename('root', '2026-09-20T07:54:23.724Z')).toBe('root-ssh-key-20260920.pem')
    expect(buildKeyFilename('wangwu', '2026-01-02T23:59:59.999Z')).toBe('wangwu-ssh-key-20260102.pem')
  })
})
