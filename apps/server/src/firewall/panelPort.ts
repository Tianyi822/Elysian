/*
 * 面板自身端口的共享禁区判据。面板由 dev server 固定服务在 PANEL_PORT/tcp
 * （vite.config.ts 的 server.port），一切可能改写这条通道的手段——端口转发的
 * DNAT、防扫描监控的 DROP——都必须在输入校验里直接拒绝，先于任何规则落盘，
 * 而不是事后靠面板端口的保底放行规则兜底。
 */

/** 面板端口：工作台自身的访问通道，规则配置的禁区。 */
export const PANEL_PORT = 5173

/** 端口或端口段是否覆盖面板端口；单端口即自身，端口段含端点。 */
export function coversPanelPort(port: number, portTo?: number | null): boolean {
  const end = portTo ?? port
  return port <= PANEL_PORT && PANEL_PORT <= end
}
