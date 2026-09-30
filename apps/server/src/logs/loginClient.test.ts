import { describe, expect, it } from 'vitest'
import { loginLocationOf, normalizePeerAddress, peerAddressFromEnv } from './loginClient'

describe('normalizePeerAddress', () => {
  it('接受 IPv4 与 IPv6，拒绝空串、zone id 与非地址', () => {
    expect(normalizePeerAddress('127.0.0.1')).toBe('127.0.0.1')
    expect(normalizePeerAddress('::1')).toBe('::1')
    expect(normalizePeerAddress('::ffff:10.0.0.8')).toBe('::ffff:10.0.0.8')
    expect(normalizePeerAddress(undefined)).toBe('未知')
    expect(normalizePeerAddress('')).toBe('未知')
    expect(normalizePeerAddress('127.0.0.1%eth0')).toBe('未知')
    expect(normalizePeerAddress('not-an-ip')).toBe('未知')
    expect(normalizePeerAddress('999.1.1.1')).toBe('未知')
  })
})

describe('loginLocationOf', () => {
  it('回环为本机，私网与链路本地为内网，公网与无法识别为未知', () => {
    expect(loginLocationOf('127.0.0.1')).toBe('本机')
    expect(loginLocationOf('::1')).toBe('本机')
    expect(loginLocationOf('::ffff:127.0.0.1')).toBe('本机')
    expect(loginLocationOf('10.1.2.3')).toBe('内网')
    expect(loginLocationOf('192.168.0.10')).toBe('内网')
    expect(loginLocationOf('172.16.0.1')).toBe('内网')
    expect(loginLocationOf('169.254.1.1')).toBe('内网')
    expect(loginLocationOf('::ffff:10.1.2.3')).toBe('内网')
    expect(loginLocationOf('fd12::1')).toBe('内网')
    expect(loginLocationOf('fe80::1')).toBe('内网')
    expect(loginLocationOf('172.15.0.1')).toBe('未知')
    expect(loginLocationOf('8.8.8.8')).toBe('未知')
    expect(loginLocationOf('未知')).toBe('未知')
  })
})

describe('peerAddressFromEnv', () => {
  it('从 env 或 env.server 的 requestIP 取地址；缺失与抛错都是未知', () => {
    const request = new Request('http://127.0.0.1/api/auth/login')
    expect(peerAddressFromEnv({ requestIP: () => ({ address: '10.0.0.8' }) }, request)).toBe('10.0.0.8')
    expect(peerAddressFromEnv({ server: { requestIP: () => ({ address: '::1' }) } }, request)).toBe('::1')
    expect(peerAddressFromEnv({}, request)).toBe('未知')
    expect(peerAddressFromEnv({ requestIP: () => { throw new Error('no server') } }, request)).toBe('未知')
    expect(peerAddressFromEnv({ requestIP: () => ({ address: 'nope' }) }, request)).toBe('未知')
  })
})
