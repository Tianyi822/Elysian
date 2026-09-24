/** 是否运行在 Docker 编排环境（由 compose 注入 ELYSIAN_DOCKER=1）。 */
export function isDockerEnv(env?: NodeJS.ProcessEnv): boolean {
  return (env ?? process.env).ELYSIAN_DOCKER === '1'
}
