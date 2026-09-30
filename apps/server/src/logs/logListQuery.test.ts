import { describe, expect, it } from 'vitest'
import { InvalidRequestError } from '../middleware/guard.ts'
import { parseOperationListQuery, parseRuntimeListQuery } from './logListQuery.ts'

function expectBadRequest(run: () => void): void {
  try {
    run()
    throw new Error('应当抛出 InvalidRequestError')
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidRequestError)
    expect((error as InvalidRequestError).status).toBe(400)
  }
}

describe('logListQuery', () => {
  it('操作日志接受分类、结果与成对游标', () => {
    const params = new URLSearchParams(
      'category=security&result=failure&q=端口&limit=10&before=2026-09-23T00:00:00.000Z&beforeId=4',
    )
    expect(parseOperationListQuery(params)).toEqual({
      category: 'security',
      result: 'failure',
      q: '端口',
      limit: 10,
      before: '2026-09-23T00:00:00.000Z',
      beforeId: 4,
    })
  })

  it('缺一个游标、越界分类、limit 为 0 都是 400', () => {
    expect(() =>
      parseOperationListQuery(new URLSearchParams('before=2026-09-23T00:00:00.000Z')),
    ).toThrow(/400|成对/)
    expectBadRequest(() =>
      parseOperationListQuery(new URLSearchParams('before=2026-09-23T00:00:00.000Z')),
    )
    expectBadRequest(() => parseOperationListQuery(new URLSearchParams('category=nope')))
    expectBadRequest(() => parseRuntimeListQuery(new URLSearchParams('limit=1001')))
    expectBadRequest(() => parseOperationListQuery(new URLSearchParams('limit=0')))
  })
})
