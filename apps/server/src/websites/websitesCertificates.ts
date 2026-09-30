import { X509Certificate, createPrivateKey, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'
import { ELYSIAN_CONFIG_DIR } from '../shared/elysianPaths.ts'
import { invalidRequest } from '../shared/errors.ts'

export type WebsiteCertificateMaterial = { certificatePem: string; privateKeyPem: string }
export type WebsiteCertificateMetadata = { issuer: string; notAfter: string; fingerprint256: string }
export type WebsiteCertificateStore = {
  save(material: WebsiteCertificateMaterial): Promise<string>
  read(ref: string): Promise<WebsiteCertificateMaterial>
  remove(ref: string): Promise<void>
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
const REF = /^[0-9a-f-]{36}$/

/** 本地受信根列表由运行时提供；只接受能沿上传链验证到公开根的证书。 */
export function validateWebsiteCertificate(
  material: WebsiteCertificateMaterial,
  domain: string,
  trustedRoots: readonly string[] = rootCertificates,
  now = new Date(),
): WebsiteCertificateMetadata {
  if (material.certificatePem.length > 96 * 1024 || material.privateKeyPem.length > 32 * 1024) throw invalidRequest('证书文件过大')
  let chain: X509Certificate[]
  try {
    const blocks = material.certificatePem.match(PEM_CERT) ?? []
    if (!blocks.length || material.certificatePem.replace(PEM_CERT, '').trim()) throw new Error('PEM 格式错误')
    chain = blocks.map((block) => new X509Certificate(block))
    const key = createPrivateKey(material.privateKeyPem)
    if (!chain[0]!.checkPrivateKey(key)) throw invalidRequest('证书与私钥不匹配')
  } catch (error) {
    if (error instanceof Error && error.message === '证书与私钥不匹配') throw error
    throw invalidRequest('证书或私钥格式无效')
  }
  const leaf = chain[0]!
  if (!leaf.checkHost(domain, { subject: 'never' })) throw invalidRequest('证书 SAN 未覆盖域名')
  for (const certificate of chain) {
    if (now < new Date(certificate.validFrom) || now >= new Date(certificate.validTo)) throw invalidRequest('证书链存在未生效或已过期证书')
  }
  const publicRoots = trustedRoots.map((pem) => new X509Certificate(pem))
  let current = leaf
  const seen = new Set<string>()
  for (let depth = 0; depth <= chain.length; depth += 1) {
    if (seen.has(current.fingerprint256)) throw invalidRequest('证书链存在循环')
    seen.add(current.fingerprint256)
    if (publicRoots.some((root) => root.fingerprint256 === current.fingerprint256)) {
      return { issuer: leaf.issuer, notAfter: new Date(leaf.validTo).toISOString(), fingerprint256: leaf.fingerprint256 }
    }
    const candidate = [...chain.slice(1), ...publicRoots].find((issuer) =>
      issuer.ca && current.checkIssued(issuer) && current.verify(issuer.publicKey))
    if (!candidate) throw invalidRequest('证书链未能验证到公开可信根，请上传完整证书链')
    current = candidate
  }
  throw invalidRequest('证书链未能验证到公开可信根')
}

export function createFileWebsiteCertificateStore(directory = join(ELYSIAN_CONFIG_DIR, 'website-certificates')): WebsiteCertificateStore {
  function pathFor(ref: string): string {
    if (!REF.test(ref)) throw invalidRequest('证书引用无效')
    return join(directory, `${ref}.json`)
  }
  return {
    async save(material) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const ref = randomUUID()
      const handle = await open(pathFor(ref), 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(material)); await handle.sync() }
      finally { await handle.close() }
      return ref
    },
    async read(ref) {
      const handle = await open(pathFor(ref), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > 128 * 1024 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('证书文件权限或内容无效')
        const value = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as WebsiteCertificateMaterial
        if (typeof value.certificatePem !== 'string' || typeof value.privateKeyPem !== 'string') throw new Error('证书文件内容无效')
        return value
      } finally { await handle.close() }
    },
    async remove(ref) { await unlink(pathFor(ref)).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) },
  }
}

export function createMemoryWebsiteCertificateStore(): WebsiteCertificateStore {
  const records = new Map<string, WebsiteCertificateMaterial>()
  return {
    async save(material) { const ref = randomUUID(); records.set(ref, { ...material }); return ref },
    async read(ref) { const material = records.get(ref); if (!material) throw new Error('证书文件不存在'); return { ...material } },
    async remove(ref) { records.delete(ref) },
  }
}
