import type { SshKeyMaterial } from '@elysian/contracts'

/*
 * 密钥的导出：全部在浏览器本地完成——只生成一个本地下载，不发任何网络请求。
 * Docker 运行时导出的是刚生成的那份真实私钥（仅一次性弹窗里可下载）；
 * 宿主机本地开发导出的是演示材料，不对应任何真实主机。Root 密钥与登录密钥共用这两个函数。
 */

/**
 * 导出文件名：<账号名>-<密钥名称>-ssh-key-<yyyymmdd>.pem——以归属账号开头（不用平台名），
 * 登录密钥带上创建时填写的名称紧随其后，同账号多把密钥下载后一眼可分；root 密钥无名称输入，
 * 不传 keyName 时保持 <账号名>-ssh-key-<日期>.pem。
 * 密钥名称校验只看非空与长度（可含中文、空格），但文件名必须安全：路径分隔符与控制字符替换为连字符。
 */
export function buildKeyFilename(account: string, exportedAt: string, keyName?: string): string {
  const day = exportedAt.slice(0, 10).replaceAll('-', '')
  const name = keyName?.trim().replace(/[\\/\u0000-\u001f\u007f]/g, '-')
  const namePart = name ? `${name}-` : ''
  return `${account}-${namePart}ssh-key-${day}.pem`
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
