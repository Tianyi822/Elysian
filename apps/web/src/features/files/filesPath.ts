/*
 * 文件页的路径纯函数。当前目录写进 URL（路由通配 files/*），
 * 这里负责通配段与绝对路径之间的换算，以及顶栏路径的前段省略决策；
 * 组件只消费结果，不自己拼字符串。
 */

/** URL 通配段归一为绝对路径：空段是根，首尾与重复斜杠都压掉。 */
export function normalizeFilesPath(raw: string): string {
  const segments = raw.split('/').filter((segment) => segment.length > 0)
  return `/${segments.join('/')}`
}

/** 当前目录接一段名字；根目录拼出不带双斜杠。 */
export function joinFilesPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/** 父目录；根目录的父目录仍是根，界面据此把「上一级」禁用。 */
export function parentFilesPath(path: string): string {
  const segments = filesPathSegments(path)
  segments.pop()
  return `/${segments.join('/')}`
}

/** 路径切段：'/var/log' → ['var', 'log']，根目录切出空数组。 */
export function filesPathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

/**
 * 顶栏路径放不下时从前面丢弃的段数。每段按「/名字」渲染，宽度由调用方量出；
 * 丢弃后以「…」起头，最后一段永远保留——运维要看的是当前在哪个目录，不是从根数起。
 *
 * available 为 Infinity（外壳还没量出预算，或测试环境尺寸全 0）时不丢段，
 * 按完整路径呈现，宁可暂时溢出也不把测试断言变成猜谜。
 */
export function pickPathDropCount(
  segmentWidths: readonly number[],
  ellipsisWidth: number,
  available: number,
): number {
  const total = segmentWidths.length
  if (total === 0) return 0

  const widthFrom = (drop: number): number => {
    const tail = segmentWidths.slice(drop).reduce((sum, width) => sum + width, 0)
    return (drop > 0 ? ellipsisWidth : 0) + tail
  }

  // 最多丢到只剩最后一段；一段都放不下时也停在这里，交给外层截断兜底。
  for (let drop = 0; drop < total - 1; drop += 1) {
    if (widthFrom(drop) <= available) return drop
  }
  return total - 1
}
