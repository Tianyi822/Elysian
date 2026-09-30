/*
 * 平台运行域：宿主依赖检测。面板对宿主 Docker Engine 与 Caddy 管理通道的就绪性
 * 探测（GET /api/platform/dependencies），server 产报告、浏览器消费同一份 JSON。
 * state 三值分界是「缺装」与「故障」：missing 表示连接类失败（未安装或未接通，
 * 引导安装），error 表示通道已通但引擎侧拒绝或故障（已安装，不引导安装）。
 * 零运行时依赖。
 */

/** 依赖检测的状态取值：ok 就绪、missing 未安装或未接通、error 已安装但通道或引擎故障。 */
export const DEPENDENCY_PROBE_STATES = ['ok', 'missing', 'error'] as const

export type DependencyProbeState = (typeof DEPENDENCY_PROBE_STATES)[number]

export type DependencyProbe = {
  state: DependencyProbeState
  /** missing / error 时的中文原因；ok 时恒为 null。 */
  detail: string | null
}

export type DependencyProbeReport = {
  docker: DependencyProbe
  caddy: DependencyProbe
}

/**
 * 依赖安装的目标。确认通道仍走探测，不在这组步骤里。
 * docker 只有 install / enable；caddy 还有 configure。非法组合由服务端拒绝。
 */
export const DEPENDENCY_SETUP_TARGETS = ['docker', 'caddy'] as const

export type DependencySetupTarget = (typeof DEPENDENCY_SETUP_TARGETS)[number]

export const DOCKER_SETUP_STEPS = ['install', 'enable'] as const

export const CADDY_SETUP_STEPS = ['install', 'configure', 'enable'] as const

export const DEPENDENCY_SETUP_STEPS = ['install', 'configure', 'enable'] as const

export type DependencySetupStep = (typeof DEPENDENCY_SETUP_STEPS)[number]

/** 一步安装的结果。失败也是 422 的中文原因，不携带宿主命令原文。 */
export type DependencySetupResult = {
  ok: boolean
  message: string
}
