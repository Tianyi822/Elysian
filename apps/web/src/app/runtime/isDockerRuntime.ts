/** 浏览器侧是否运行在 Docker 编排环境（compose 注入 ELSYIAN_DOCKER=1，经 Vite define 暴露）。 */
export function isDockerRuntime(): boolean {
  return import.meta.env.ELSYIAN_DOCKER === '1'
}
