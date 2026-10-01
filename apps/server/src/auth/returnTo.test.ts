import { describe, expect, it } from 'vitest'
import { adjudicateReturnTo } from './returnTo.ts'
import { RETURN_TO_MAX_LENGTH } from './authConfig.ts'

/*
 * 回跳裁决：只有 origin 精确落在名单里的绝对 http/https 地址可用，且 host 必须仍在回环名单内。
 * 通过时回的是规范化 href——浏览器所见即裁决所判，归一化不在其后另发生一次。
 */

const ALLOWED = ['http://127.0.0.1:5173', 'http://127.0.0.1:48100']

describe('adjudicateReturnTo', () => {
  it('命中名单时回规范化 href，path、query 与 hash 全部保留', () => {
    expect(adjudicateReturnTo('http://127.0.0.1:5173/projects/42?page=2#top', ALLOWED)).toBe(
      'http://127.0.0.1:5173/projects/42?page=2#top',
    )
  })

  it('首尾空白先 trim；协议与主机大小写经 URL 归一后命中', () => {
    expect(adjudicateReturnTo('  http://127.0.0.1:5173/x  ', ALLOWED)).toBe('http://127.0.0.1:5173/x')
    expect(adjudicateReturnTo('HTTP://127.0.0.1:5173/x', ALLOWED)).toBe('http://127.0.0.1:5173/x')
  })

  it('空名单恒 null（白名单不可用即不开放跳转）', () => {
    expect(adjudicateReturnTo('http://127.0.0.1:5173/x', [])).toBeNull()
  })

  it('null、undefined、空串与纯空白恒 null', () => {
    expect(adjudicateReturnTo(null, ALLOWED)).toBeNull()
    expect(adjudicateReturnTo(undefined, ALLOWED)).toBeNull()
    expect(adjudicateReturnTo('', ALLOWED)).toBeNull()
    expect(adjudicateReturnTo('   ', ALLOWED)).toBeNull()
  })

  it('相对地址与协议相对地址解析不出绝对 origin，一律 null', () => {
    expect(adjudicateReturnTo('/projects/42', ALLOWED)).toBeNull()
    expect(adjudicateReturnTo('//127.0.0.1:5173/projects', ALLOWED)).toBeNull()
  })

  it('端口不同即不同 origin', () => {
    expect(adjudicateReturnTo('http://127.0.0.1:5174/x', ALLOWED)).toBeNull()
  })

  it('localhost 与 127.0.0.1 是两个 cookie 家，互不认', () => {
    expect(adjudicateReturnTo('http://localhost:5173/x', ALLOWED)).toBeNull()
  })

  it('非 http/https 协议 null', () => {
    expect(adjudicateReturnTo('javascript:alert(1)', ALLOWED)).toBeNull()
    expect(adjudicateReturnTo('data:text/html,hi', ALLOWED)).toBeNull()
  })

  it('反斜杠变形只改变 path，主机仍是名单内的那个', () => {
    // WHATWG 对 special scheme 把 \ 当路径分隔符：实测归一为 http://127.0.0.1:5173//@evil.example，
    // 主机停在 127.0.0.1:5173，跳转不出外站。断言只锁「结果 origin 仍是名单内的那个」，
    // 不钉死斜杠数量——那是 URL 规范的实现细节，钉住它会让计划随解析器版本腐坏。
    const result = adjudicateReturnTo('http://127.0.0.1:5173\\@evil.example', ALLOWED)
    expect(result).not.toBeNull()
    expect(new URL(result as string).origin).toBe('http://127.0.0.1:5173')
  })

  it('用 userinfo 伪装名单内主机不能把跳转带向外站', () => {
    // 实测：host 取 @ 之后的 evil.example，origin 因此不在名单内。
    expect(adjudicateReturnTo('http://127.0.0.1:5173@evil.example/', ALLOWED)).toBeNull()
  })

  it('名单里被误写进外部域名时，hostname 闸仍然 null（纵深防御）', () => {
    expect(adjudicateReturnTo('http://evil.example/x', ['http://evil.example'])).toBeNull()
  })

  it('恰好 RETURN_TO_MAX_LENGTH 的地址被接受，多一个字符即拒（长度上限边界）', () => {
    const base = 'http://127.0.0.1:5173/'
    const exact = base + 'a'.repeat(RETURN_TO_MAX_LENGTH - base.length)
    expect(exact.length).toBe(RETURN_TO_MAX_LENGTH)
    expect(adjudicateReturnTo(exact, ALLOWED)).toBe(exact)
    // 超一个字符就落到长度闸之外，不交给 URL 解析。
    expect(adjudicateReturnTo(`${exact}a`, ALLOWED)).toBeNull()
  })

  it('超过 RETURN_TO_MAX_LENGTH 直接 null，不交给 URL 解析', () => {
    const long = `http://127.0.0.1:5173/${'a'.repeat(RETURN_TO_MAX_LENGTH)}`
    expect(adjudicateReturnTo(long, ALLOWED)).toBeNull()
  })
})
