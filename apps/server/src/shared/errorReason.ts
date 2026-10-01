/*
 * 诊断归因提取：从任意抛值（Error、ErrnoException、字符串、乃至 null 等非对象）安全取一行
 * 归因文本，供退化路径写 stderr 诊断时复用。零依赖、值安全——绝不因二次取属性而抛错，
 * 免得「取归因」这一步本身把已决定退化的分支变成 reject。
 */

/**
 * 从任意抛值安全提取诊断归因：优先 errno code，其次非空 message（字符串抛值本身也算），
 * 都拿不到回「未知错误」。对 null 等非对象抛值只做 typeof 判断后取属性，绝不二次抛错
 * 把退化本身变成 reject。鉴权域各退化诊断（白名单读取的两处 catch、路由按空表回跳）共用它，
 * 保证归因口径一致。
 */
export function errorReason(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (typeof code === 'string' && code.length > 0) return code
    if (typeof message === 'string' && message.length > 0) return message
    return '未知错误'
  }
  if (typeof error === 'string' && error.length > 0) return error
  return '未知错误'
}
