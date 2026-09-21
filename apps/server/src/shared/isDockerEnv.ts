/*
 * Docker 编排环境判定（server 侧副本）。与 `apps/web/src/adapters/hostMetrics/isDockerEnv.ts`
 * 是有意的双份：它读 process.env，不进 @elysian/contracts（契约保持零环境依赖）；
 * web 侧那份服务 SSE mock 插件，这里服务安全三片的容器边界，两处互指、不合并。
 */

/** 是否运行在 Docker 编排环境（由 compose 注入 ELSYIAN_DOCKER=1）。 */
export function isDockerEnv(env?: NodeJS.ProcessEnv): boolean {
  return (env ?? process.env).ELSYIAN_DOCKER === '1'
}
