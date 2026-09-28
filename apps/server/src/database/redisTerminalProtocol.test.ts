import { expect, it } from 'vitest'
import { parseRedisReply } from './redisTerminalProtocol.ts'

it('RESP2 解析完整与分段结果，并在读取大结果前拒绝长度头', () => {
  expect(parseRedisReply(Buffer.from('$5\r\nhello\r\n'))).toEqual({ value: 'hello', next: 11 })
  expect(parseRedisReply(Buffer.from('$5\r\nhel'))).toBeUndefined()
  expect(parseRedisReply(Buffer.from('*2\r\n:1\r\n$3\r\nfoo\r\n'))).toEqual({ value: [1, 'foo'], next: 17 })
  expect(parseRedisReply(Buffer.from('-ERR denied\r\n'))).toMatchObject({ error: 'ERR denied' })
  expect(() => parseRedisReply(Buffer.from('$999999999\r\n'))).toThrow('1 MiB')
  expect(() => parseRedisReply(Buffer.from('*999999999\r\n'))).toThrow('500 项')
})
