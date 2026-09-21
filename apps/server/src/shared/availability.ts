import { isDockerEnv } from './isDockerEnv.ts'

/*
 * 安全三片（防火墙/SSH/用户管理）共享的容器可用性判据：环境变量声明 Docker 编排
 * （ELSYIAN_DOCKER=1）且 /.dockerenv 证明进程真的在容器内，两者缺一不可。
 * 判据只此一份，三片接线统一调用，不许各自复制——改坏任何一片的边界都会在这里被钉住。
 */

/**
 * 容器硬边界的判定：available = isDockerEnv(env) && dockerenvExists。
 * 调用方注入 /.dockerenv 的探测结果（接线层用 existsSync，测试注入布尔值），
 * 本函数保持纯：不读环境、不碰文件系统。
 */
export function resolveAvailability(env: NodeJS.ProcessEnv, dockerenvExists: boolean): boolean {
  return isDockerEnv(env) && dockerenvExists
}
