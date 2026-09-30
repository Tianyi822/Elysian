/*
 * 依赖引导弹窗的集中文案。面板在宿主上分步执行，弹窗把每一步都留在窗口里，
 * 成功后滑到下一步。步骤口径与 docker-compose.yml 注释里的宿主侧安装说明一致
 * （官方安装脚本或 apt 仓库、systemd 常驻、admin unix socket、目录级 bind）。
 * successNotice 供 store 的成功通知与弹窗文案共用同一字面量。
 */

export type DependencyGuideKind = 'docker' | 'caddy'

export type DependencyGuideStageId = 'install' | 'configure' | 'enable' | 'verify'

export type DependencyGuideStage = {
  id: DependencyGuideStageId
  title: string
  /** 这一步面板在做什么。 */
  detail: string
}

export type DependencyGuideContent = {
  title: string
  /** 引导语；同时是 Dialog.Description。 */
  lead: string
  stages: readonly DependencyGuideStage[]
  /** 依赖经确认步骤转就绪时的成功通知文案（store 发、单一字面量）。 */
  successNotice: string
}

export const DEPENDENCY_GUIDE_CONTENT: Record<DependencyGuideKind, DependencyGuideContent> = {
  docker: {
    title: '安装 Docker',
    lead: 'Docker 引擎不可用，容器、数据库与网站功能都依赖宿主 Docker。面板会在宿主上分步安装，一步成功后自动进入下一步。',
    stages: [
      {
        id: 'install',
        title: '安装 Docker',
        detail: '在宿主上执行 Docker 官方安装脚本。引擎已经在运行时会直接跳过。',
      },
      {
        id: 'enable',
        title: '开机自启',
        detail: '执行 systemctl enable --now docker，让引擎开机即起。',
      },
      {
        id: 'verify',
        title: '确认接通',
        detail: '确认面板能连上引擎。若面板跑在容器里且 socket 是新出现的，需要重启面板容器后再试。',
      },
    ],
    successNotice: 'Docker 已就绪',
  },
  caddy: {
    title: '安装 Caddy',
    lead: '反向代理通道不可用，域名路由与 HTTPS 证书需要宿主上的系统级 Caddy。面板会在宿主上分步安装，一步成功后自动进入下一步；站点容器不受影响，照常运行。',
    stages: [
      {
        id: 'install',
        title: '安装 Caddy',
        detail: '配置 Caddy 官方软件源并安装。已经装好时会直接跳过。',
      },
      {
        id: 'configure',
        title: '绑定管理通道',
        detail: '在 Caddyfile 全局段写入管理端点，绑定到面板使用的 unix socket。',
      },
      {
        id: 'enable',
        title: '启动并常驻',
        detail: '保证 /run/caddy 开机即在，并启动 Caddy、设为开机自启。',
      },
      {
        id: 'verify',
        title: '确认通道',
        detail: '确认管理通道可连通。compose 已把 /run/caddy 挂进面板容器。',
      },
    ],
    successNotice: 'Caddy 管理通道已就绪',
  },
}
