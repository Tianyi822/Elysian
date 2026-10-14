import { describe, expect, it } from 'vitest'
import { CONTAINER_STATUS_LABELS, classifyPortBind, isSensitiveEnvKey } from '../index.ts'

describe('classifyPortBind', () => {
  it('回环、通配、具体地址与缺省', () => {
    expect(classifyPortBind('127.0.0.1')).toBe('local')
    expect(classifyPortBind('::1')).toBe('local')
    expect(classifyPortBind('0.0.0.0')).toBe('public')
    expect(classifyPortBind('::')).toBe('public')
    expect(classifyPortBind('192.168.1.5')).toBe('address')
    expect(classifyPortBind(undefined)).toBe('unspecified')
    expect(classifyPortBind('')).toBe('unspecified')
  })
})

describe('isSensitiveEnvKey', () => {
  it('按子串识别，大小写不敏感', () => {
    expect(isSensitiveEnvKey('db_password')).toBe(true)
    expect(isSensitiveEnvKey('API_TOKEN')).toBe(true)
    expect(isSensitiveEnvKey('aws_secret_key')).toBe(true)
    expect(isSensitiveEnvKey('TZ')).toBe(false)
    expect(isSensitiveEnvKey('POSTGRES_USER')).toBe(false)
  })
})

describe('暂停状态标签', () => {
  it('paused 的中文是已暂停', () => {
    expect(CONTAINER_STATUS_LABELS.paused).toBe('已暂停')
  })
})
