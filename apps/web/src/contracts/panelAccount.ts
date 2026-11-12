/** 面板用户名的前端预检；服务端再次执行同样的约束。 */
export function panelUsernameError(username: string, current?: string): string | null {
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) return '用户名须为 3–32 位英文字母、数字、下划线或短横线'
  if (username === 'dev') return '不能使用开发保留用户名 dev'
  if (username === current) return '新用户名不能与当前用户名相同'
  return null
}
