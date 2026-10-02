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
  /**
   * 这套引导在做什么：说人话的三段——缺了什么、影响什么、面板怎么装。
   * 收在标题右侧的问号里，不占弹窗正文。
   */
  help: readonly string[]
  stages: readonly DependencyGuideStage[]
  /** 依赖经确认步骤转就绪时的成功通知文案（store 发、单一字面量）。 */
  successNotice: string
}

export const DEPENDENCY_GUIDE_CONTENT: Record<DependencyGuideKind, DependencyGuideContent> = {
  docker: {
    title: '安装 Docker',
    help: [
      '这台机器上还没有可用的 Docker 引擎，容器、数据库与网站三个页面都要靠它运行。',
      '面板会分步代装：先装引擎，再设为开机自启，最后确认可连通。每步成功自动进入下一步。',
      '某一步失败会停在那一步并写明原因，重试从失败的那一步继续，不会从头再装。',
    ],
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
    help: [
      '网站用域名访问时的 HTTPS 证书与转发，由这台机器上的 Caddy 负责，面板自己不处理。',
      '现在机器上没有 Caddy，所以域名访问用不了；用服务器 IP 加端口访问的网站不受影响，照常运行。',
      '面板会分步代装：装软件、接上面板、设为开机自启、确认可连通。每步成功自动进入下一步。',
      '某一步失败会停在那一步并写明原因，重试从失败的那一步继续，不会从头再装。',
    ],
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
