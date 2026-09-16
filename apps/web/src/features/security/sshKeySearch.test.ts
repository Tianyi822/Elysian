import { describe, expect, it } from 'vitest'
import type { SshLoginKey } from '@elysian/contracts'
import { filterSshKeys, matchesSshKey, normalizeKeySearch } from './sshKeySearch'

/*
 * 密钥搜索的判据：粘一整份私钥要能准确命中，按名称片段或指纹也要命中。
 * 这些用例就是「搜完整密钥能不能准确匹配」这条要求的守卫。
 */

const DEPLOY_PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQABZGVwbG95LWtleQ',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n')

const CI_PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQABY2ktcHVibGlzaA',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n')

const DEPLOY_KEY: SshLoginKey = {
  id: 'key-部署机',
  name: '部署机',
  algorithm: 'ssh-ed25519 256',
  fingerprint: 'SHA256:kV3Hq2xN7dTr9pLwZ0bYc4mA1sEu6fJgOi5RTn8XvWk',
  createdAt: '2025-06-10T21:56:30',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAb3xK 部署机@elysian-demo',
  privateKey: DEPLOY_PRIVATE_KEY,
}

const CI_KEY: SshLoginKey = {
  ...DEPLOY_KEY,
  id: 'key-CI 发布',
  name: 'CI 发布',
  fingerprint: 'SHA256:Zq7Wm1pT4vB9yR2cL5nJ8dK3sH6gX0aQfEuMiOtNwVr',
  privateKey: CI_PRIVATE_KEY,
}

const KEYS: readonly SshLoginKey[] = [DEPLOY_KEY, CI_KEY]

describe('密钥搜索', () => {
  it('关键词归一化：去掉全部空白并统一小写', () => {
    expect(normalizeKeySearch('  SHA256: kV3Hq2  ')).toBe('sha256:kv3hq2')
  })

  it('粘一整份私钥（跨多行）准确命中同一行，且只命中它', () => {
    expect(filterSshKeys(DEPLOY_PRIVATE_KEY, KEYS)).toEqual([DEPLOY_KEY])
    expect(filterSshKeys(CI_PRIVATE_KEY, KEYS)).toEqual([CI_KEY])
  })

  it('只粘私钥的正文行也能命中', () => {
    expect(filterSshKeys('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQABY2ktcHVibGlzaA', KEYS)).toEqual([
      CI_KEY,
    ])
  })

  it('私钥里的换行被输入框吞掉或折成空格，都不影响命中', () => {
    expect(matchesSshKey(DEPLOY_PRIVATE_KEY.replace(/\n/g, '   '), DEPLOY_KEY)).toBe(true)
    expect(matchesSshKey(DEPLOY_PRIVATE_KEY.replace(/\n/g, ''), DEPLOY_KEY)).toBe(true)
  })

  it('粘指纹命中，大小写不敏感', () => {
    expect(filterSshKeys('sha256:zq7wm1pt4vb9yr2cl5nj8dk3sh6gx0aqfeumiotnwvr', KEYS)).toEqual([CI_KEY])
    expect(filterSshKeys(DEPLOY_KEY.fingerprint.toUpperCase(), KEYS)).toEqual([DEPLOY_KEY])
  })

  it('按名称片段命中', () => {
    expect(filterSshKeys('发布', KEYS)).toEqual([CI_KEY])
    expect(filterSshKeys('部署机', KEYS)).toEqual([DEPLOY_KEY])
  })

  it('关键词为空时返回全部，搜不到时返回空列表', () => {
    expect(filterSshKeys('   ', KEYS)).toEqual(KEYS)
    expect(filterSshKeys('不存在的一把密钥', KEYS)).toEqual([])
  })
})
