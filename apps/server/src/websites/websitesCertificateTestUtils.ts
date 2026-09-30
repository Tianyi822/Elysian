import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 测试专用临时 CA，绝不进入产品信任列表；openssl 参数数组不经 shell。 */
export function makeTestChain(domain = 'example.com') {
  const dir = mkdtempSync(join(tmpdir(), 'elysian-cert-test-'))
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' })
  try {
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.crt', '-days', '365', '-subj', '/CN=Test Root', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=keyCertSign,cRLSign')
    run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'intermediate.key', '-out', 'intermediate.csr', '-subj', '/CN=Test Intermediate')
    writeFileSync(join(dir, 'intermediate.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
    run('x509', '-req', '-in', 'intermediate.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'intermediate.crt', '-days', '300', '-extfile', 'intermediate.ext')
    run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', `/CN=${domain}`)
    writeFileSync(join(dir, 'leaf.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${domain}\nauthorityKeyIdentifier=keyid,issuer\n`)
    run('x509', '-req', '-in', 'leaf.csr', '-CA', 'intermediate.crt', '-CAkey', 'intermediate.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '90', '-extfile', 'leaf.ext')
    const read = (name: string) => readFileSync(join(dir, name), 'utf8')
    return {
      certificatePem: `${read('leaf.crt')}${read('intermediate.crt')}`,
      privateKeyPem: read('leaf.key'),
      rootPem: read('root.crt'),
      leafPem: read('leaf.crt'),
      intermediatePem: read('intermediate.crt'),
      otherKeyPem: read('root.key'),
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function makeSelfSignedTestCertificate(domain = 'example.com') {
  const dir = mkdtempSync(join(tmpdir(), 'elysian-self-signed-test-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.crt', '-days', '30', '-subj', `/CN=${domain}`, '-addext', `subjectAltName=DNS:${domain}`, '-addext', 'basicConstraints=critical,CA:FALSE'], { cwd: dir, stdio: 'pipe' })
    return { certificatePem: readFileSync(join(dir, 'leaf.crt'), 'utf8'), privateKeyPem: readFileSync(join(dir, 'leaf.key'), 'utf8') }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
