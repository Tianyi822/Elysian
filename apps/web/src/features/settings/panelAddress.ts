/** 只替换端口，保留浏览器实际使用的 IP（包括 IPv6），不接受服务端任意跳转地址。 */
export function panelAddress(port: number, origin = window.location.origin): string {
  const url = new URL(origin); url.port = String(port); url.pathname = '/settings'; url.search = ''; url.hash = ''
  return url.toString()
}
