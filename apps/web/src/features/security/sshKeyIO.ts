import type { SshKeyMaterial } from '@elysian/contracts'

/*
 * 密钥的导出：全部在浏览器本地完成——只生成一个本地下载，不发任何网络请求。
 * 导出的是演示密钥材料，不对应任何真实主机。Root 密钥与登录密钥共用这两个函数。
 */

/** 导出文件名：elysian-demo-ssh-key-<yyyymmdd>.pem。 */
export function buildKeyFilename(exportedAt: string): string {
  const day = exportedAt.slice(0, 10).replaceAll('-', '')
  return `elysian-demo-ssh-key-${day}.pem`
}

/** 生成本地下载（Blob 加临时链接），不经过网络。 */
export function downloadPrivateKey(filename: string, material: SshKeyMaterial): void {
  const blob = new Blob([`${material.privateKey ?? ''}\n`], { type: 'application/x-pem-file' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
