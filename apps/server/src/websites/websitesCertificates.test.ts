import { describe, expect, it } from 'vitest'
import { createMemoryWebsiteCertificateStore, validateWebsiteCertificate } from './websitesCertificates.ts'
import { makeSelfSignedTestCertificate, makeTestChain } from './websitesCertificateTestUtils.ts'

describe('用户证书校验', () => {
  it('接受完整链，并只返回公开元数据', () => {
    const chain = makeTestChain()
    const metadata = validateWebsiteCertificate(chain, 'example.com', [chain.rootPem])
    expect(metadata.issuer).toContain('Test Intermediate')
    expect(metadata.fingerprint256).toMatch(/^[0-9A-F:]+$/)
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE KEY')
  })

  it('拒绝错域名、错私钥、缺中间证书、私有 CA 和过期证书', () => {
    const chain = makeTestChain()
    expect(() => validateWebsiteCertificate(chain, 'other.example.com', [chain.rootPem])).toThrow('SAN')
    expect(() => validateWebsiteCertificate({ ...chain, privateKeyPem: chain.otherKeyPem }, 'example.com', [chain.rootPem])).toThrow('不匹配')
    expect(() => validateWebsiteCertificate({ ...chain, certificatePem: chain.leafPem }, 'example.com', [chain.rootPem])).toThrow('完整证书链')
    expect(() => validateWebsiteCertificate(chain, 'example.com', [])).toThrow('公开可信根')
    expect(() => validateWebsiteCertificate(chain, 'example.com', [chain.rootPem], new Date('2030-01-01'))).toThrow('已过期')
  })

  it('拒绝自签名站点证书', () => {
    expect(() => validateWebsiteCertificate(makeSelfSignedTestCertificate(), 'example.com', [])).toThrow('公开可信根')
  })

  it('私钥只经证书存储引用读取', async () => {
    const store = createMemoryWebsiteCertificateStore()
    const material = { certificatePem: 'cert', privateKeyPem: 'secret' }
    const ref = await store.save(material)
    expect(ref).not.toContain('secret')
    expect(await store.read(ref)).toEqual(material)
    await store.remove(ref)
    await expect(store.read(ref)).rejects.toThrow('不存在')
  })
})
