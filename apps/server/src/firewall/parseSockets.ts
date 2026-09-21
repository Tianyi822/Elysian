/*
 * `ss -Hultn` 输出解析：监听中的 TCP/UDP 端口集合，用于派生规则的「正常/未使用」。
 * 形状取自容器内真实输出（-t 与 -u 混用时首列是协议名，列间多空格分隔）：
 *
 *   udp UNCONN 0      0      127.0.0.11:37622 0.0.0.0:*
 *   tcp LISTEN 0      512             *:5173        *:*
 */

/** 解析出监听键集合，元素形如 `tcp:22`。 */
export function parseSsListening(stdout: string): ReadonlySet<string> {
  const listeners = new Set<string>()
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const columns = line.split(/\s+/)
    if (columns.length < 6) continue
    const proto = columns[0] === 'udp' ? 'udp' : columns[0] === 'tcp' ? 'tcp' : null
    const state = columns[1]
    if (!proto || (proto === 'tcp' && state !== 'LISTEN')) continue
    // 列序：协议、状态、接收队列、发送队列、本地地址、对端地址。
    const local = columns[4] ?? ''
    const portText = local.slice(local.lastIndexOf(':') + 1)
    if (!/^\d{1,5}$/.test(portText)) continue
    listeners.add(`${proto}:${Number.parseInt(portText, 10)}`)
  }
  return listeners
}
