/*
 * 平台运行域：宿主依赖检测。面板对宿主 Docker Engine 与 Caddy 管理通道的就绪性
 * 探测（GET /api/platform/dependencies），server 产报告、浏览器消费同一份 JSON。
 * state 三值分界是「缺装」与「故障」：missing 表示连接类失败（未安装或未接通），
 * error 表示通道已通但引擎侧拒绝或故障（已安装）。
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
